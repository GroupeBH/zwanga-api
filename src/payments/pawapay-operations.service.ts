import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { In, LessThan, Repository } from 'typeorm';
import {
  PawaPayRefund,
  PawaPayRefundStatus,
} from './entities/pawapay-refund.entity';
import {
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';
import { PawaPayService } from './pawapay.service';
import { PaymentsService } from './payments.service';
import { assertPawaPayId } from './pawapay-snapshot';
import type { PawaPayPaymentSnapshot } from './pawapay.types';
import type { PawaPayCreateRefundDto } from './dto/pawapay-operations.dto';
import { PaymentGatewayUnavailableError } from './payment-provider.policy';

@Injectable()
export class PawaPayOperationsService {
  private readonly logger = new Logger(PawaPayOperationsService.name);
  private reconciling = false;

  constructor(
    @InjectRepository(PaymentTransaction)
    private readonly paymentRepository: Repository<PaymentTransaction>,
    @InjectRepository(PawaPayRefund)
    private readonly refundRepository: Repository<PawaPayRefund>,
    private readonly pawaPayService: PawaPayService,
    private readonly paymentsService: PaymentsService,
    private readonly configService: ConfigService,
  ) {}

  async getSupportedMethods(): Promise<unknown[]> {
    const config = await this.pawaPayService.getActiveConfiguration();
    const countries = config.countries as Array<Record<string, unknown>>;
    const cod = countries.find((country) => country.country === 'COD');
    const providers = Array.isArray(cod?.providers)
      ? (cod.providers as Array<Record<string, unknown>>)
      : [];
    return providers.map((provider) => ({
      provider: provider.provider,
      displayName: provider.displayName,
      logo: provider.logo,
      currencies: (Array.isArray(provider.currencies)
        ? (provider.currencies as Array<Record<string, unknown>>)
        : []
      ).map((currency) => ({
        currency: currency.currency,
        operationTypes: (Array.isArray(currency.operationTypes)
          ? (currency.operationTypes as Array<Record<string, unknown>>)
          : []
        )
          .map((operation) => {
            const type =
              typeof operation.operationType === 'string'
                ? operation.operationType
                : ['DEPOSIT', 'PAYOUT'].find((name) => name in operation);
            if (!type || !['DEPOSIT', 'PAYOUT'].includes(type)) return null;
            const detail =
              typeof operation[type] === 'object' && operation[type]
                ? (operation[type] as Record<string, unknown>)
                : operation;
            return {
              type,
              status: detail.status,
              minAmount: detail.minTransactionLimit,
              maxAmount: detail.maxTransactionLimit,
              decimalsInAmount: detail.decimalsInAmount,
              authType: detail.authType,
              pinPrompt: detail.pinPrompt,
              pinPromptInstructions: detail.pinPromptInstructions,
            };
          })
          .filter(Boolean),
      })),
    }));
  }

  async getAvailability(): Promise<unknown> {
    const availability = await this.pawaPayService.getAvailability();
    return Array.isArray(availability)
      ? availability.filter(
          (item: unknown) =>
            item !== null &&
            typeof item === 'object' &&
            (item as Record<string, unknown>).country === 'COD',
        )
      : [];
  }

  async createRefund(
    dto: PawaPayCreateRefundDto,
    actorUserId: string,
  ): Promise<PawaPayRefund> {
    if (this.configService.get<string>('PAWAPAY_REFUNDS_ENABLED') !== 'true') {
      throw new BadRequestException(
        'Les remboursements PawaPay ne sont pas activés',
      );
    }
    if (!this.pawaPayService.isConfigured()) {
      throw new ServiceUnavailableException('PawaPay n’est pas configuré');
    }
    assertPawaPayId(dto.refundId);
    const amount = Number(dto.amount);
    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      Math.abs(Math.round(amount * 100) - amount * 100) > 0.000001
    ) {
      throw new BadRequestException('Montant de remboursement invalide');
    }
    const refund = await this.refundRepository.manager.transaction(
      async (manager) => {
        const payment = await manager.findOne(PaymentTransaction, {
          where: { id: dto.paymentTransactionId },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !payment ||
          payment.provider !== PaymentProvider.PAWAPAY ||
          payment.status !== PaymentStatus.SUCCEEDED ||
          !payment.orderNumber ||
          ['driver_payout', 'wallet_payout', 'referral_payout'].includes(
            payment.purpose,
          )
        ) {
          throw new BadRequestException(
            'Seul un dépôt PawaPay confirmé peut être remboursé',
          );
        }
        const existing = await manager.findOne(PawaPayRefund, {
          where: { id: dto.refundId },
        });
        if (existing) {
          if (
            existing.paymentTransactionId !== payment.id ||
            Number(existing.amount) !== amount
          ) {
            throw new BadRequestException(
              'Identifiant de remboursement déjà utilisé',
            );
          }
          return existing;
        }
        if (
          payment.purpose !== String(PaymentPurpose.GENERIC) &&
          !dto.businessReversalReference?.trim()
        ) {
          throw new BadRequestException(
            'Référence de régularisation métier requise avant le remboursement',
          );
        }
        const prior = await manager.find(PawaPayRefund, {
          where: { paymentTransactionId: payment.id },
        });
        const reservedCents = prior
          .filter((item) => item.status !== PawaPayRefundStatus.FAILED)
          .reduce(
            (sum, item) => sum + Math.round(Number(item.amount) * 100),
            0,
          );
        if (
          reservedCents + Math.round(amount * 100) >
          Math.round(Number(payment.amount) * 100)
        ) {
          throw new BadRequestException(
            'Le total des remboursements dépasse le dépôt',
          );
        }
        return manager.save(
          PawaPayRefund,
          manager.create(PawaPayRefund, {
            id: dto.refundId,
            paymentTransactionId: payment.id,
            createdByUserId: actorUserId,
            amount,
            currency: payment.currency,
            reason: dto.reason.trim(),
            businessReversalReference:
              dto.businessReversalReference?.trim() ?? null,
            status: PawaPayRefundStatus.CREATED,
          }),
        );
      },
    );
    if (refund.status !== PawaPayRefundStatus.CREATED) return refund;
    return this.submitRefund(refund);
  }

  async retryRefund(refundId: string): Promise<PawaPayRefund> {
    if (this.configService.get<string>('PAWAPAY_REFUNDS_ENABLED') !== 'true') {
      throw new BadRequestException(
        'Les remboursements PawaPay ne sont pas activés',
      );
    }
    const refund = await this.getRefund(refundId);
    if (
      [PawaPayRefundStatus.COMPLETED, PawaPayRefundStatus.FAILED].includes(
        refund.status,
      )
    ) {
      return refund;
    }
    if (Date.now() - new Date(refund.createdAt).getTime() < 120_000) {
      throw new BadRequestException(
        'Attendez deux minutes avant de reprendre ce remboursement',
      );
    }
    const snapshot = await this.pawaPayService.checkRefund(refund.id);
    if (snapshot.status !== 'NOT_FOUND') {
      return this.applyRefundSnapshot(refund, snapshot);
    }
    // pawaPay deduplicates financial requests by refundId. Always reuse the persisted UUID.
    return this.submitRefund(refund);
  }

  private async submitRefund(refund: PawaPayRefund): Promise<PawaPayRefund> {
    const payment = await this.paymentRepository.findOneByOrFail({
      id: refund.paymentTransactionId,
    });
    let result: Awaited<ReturnType<PawaPayService['initiateRefund']>>;
    try {
      result = await this.pawaPayService.initiateRefund({
        refundId: refund.id,
        depositId: payment.orderNumber!,
        amount: Number(refund.amount),
        currency: refund.currency,
        clientReferenceId: payment.reference,
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        (error instanceof PaymentGatewayUnavailableError &&
          !error.uncertainDelivery)
      ) {
        await this.commitRefund(refund.id, {
          status: PawaPayRefundStatus.FAILED,
          providerMessage:
            error instanceof Error
              ? error.message
              : 'Rejet du remboursement PawaPay',
        });
        throw error;
      }
      // A timeout or a malformed response cannot prove that the refund did not reach pawaPay.
      this.logger.error(
        `Refund initiation uncertain: refundId=${refund.id}`,
        error instanceof Error ? error.stack : undefined,
      );
      return this.commitRefund(refund.id, {
        status: PawaPayRefundStatus.INITIATED,
        providerMessage:
          'Initiation incertaine, vérification du statut en cours',
      });
    }
    return this.commitRefund(refund.id, {
      status: result.accepted
        ? PawaPayRefundStatus.INITIATED
        : PawaPayRefundStatus.FAILED,
      providerStatusCode: result.status,
      providerMessage: result.failureMessage,
      rawInitiationResponse: result.raw,
    });
  }

  async getRefund(refundId: string): Promise<PawaPayRefund> {
    assertPawaPayId(refundId);
    const refund = await this.refundRepository.findOneBy({ id: refundId });
    if (!refund)
      throw new NotFoundException('Remboursement PawaPay introuvable');
    return refund;
  }

  async listRefunds(paymentTransactionId: string): Promise<PawaPayRefund[]> {
    const payment = await this.getPawaPayPayment(paymentTransactionId);
    return this.refundRepository.find({
      where: { paymentTransactionId: payment.id },
      order: { createdAt: 'DESC' },
    });
  }

  async checkRefund(refundId: string): Promise<PawaPayRefund> {
    const refund = await this.getRefund(refundId);
    if (refund.status === PawaPayRefundStatus.COMPLETED) return refund;
    const snapshot = await this.pawaPayService.checkRefund(refund.id);
    return this.applyRefundSnapshot(refund, snapshot);
  }

  async handleRefundCallback(payload: Record<string, unknown>): Promise<{
    received: true;
    status: PawaPayRefundStatus;
    refundId: string;
  }> {
    const callback = this.pawaPayService.normalizeCallback('refunds', payload);
    const refund = await this.getRefund(callback.paymentId);
    const checked = await this.checkRefund(refund.id);
    if (
      ['COMPLETED', 'FAILED'].includes(callback.status) &&
      ![PawaPayRefundStatus.COMPLETED, PawaPayRefundStatus.FAILED].includes(
        checked.status,
      )
    ) {
      throw new BadGatewayException(
        'Confirmation de remboursement PawaPay encore en attente',
      );
    }
    return { received: true, status: checked.status, refundId: refund.id };
  }

  async checkPayment(
    paymentTransactionId: string,
  ): Promise<PaymentTransaction> {
    const payment = await this.getPawaPayPayment(paymentTransactionId);
    if (!payment.orderNumber)
      throw new BadRequestException('Identifiant PawaPay absent');
    return this.paymentsService.checkPaymentStatus(
      payment.orderNumber,
      undefined,
      true,
    );
  }

  async resendPaymentCallback(paymentTransactionId: string): Promise<unknown> {
    const payment = await this.getPawaPayPayment(paymentTransactionId);
    if (!payment.orderNumber)
      throw new BadRequestException('Identifiant PawaPay absent');
    return this.pawaPayService.resendCallback(
      this.isPayout(payment) ? 'payouts' : 'deposits',
      payment.orderNumber,
    );
  }

  async resendRefundCallback(refundId: string): Promise<unknown> {
    const refund = await this.getRefund(refundId);
    return this.pawaPayService.resendCallback('refunds', refund.id);
  }

  async failEnqueuedPayout(
    paymentTransactionId: string,
  ): Promise<PaymentTransaction> {
    const payment = await this.getPawaPayPayment(paymentTransactionId);
    if (!this.isPayout(payment) || !payment.orderNumber)
      throw new BadRequestException('Versement PawaPay introuvable');
    const snapshot = await this.pawaPayService.checkPayout(payment.orderNumber);
    if (snapshot.status !== 'ENQUEUED')
      throw new BadRequestException(
        'Seul un versement ENQUEUED peut être annulé',
      );
    await this.pawaPayService.failEnqueued('payouts', payment.orderNumber);
    return this.checkPayment(payment.id);
  }

  async failEnqueuedRefund(refundId: string): Promise<PawaPayRefund> {
    const refund = await this.getRefund(refundId);
    const snapshot = await this.pawaPayService.checkRefund(refund.id);
    if (snapshot.status !== 'ENQUEUED')
      throw new BadRequestException(
        'Seul un remboursement ENQUEUED peut être annulé',
      );
    await this.pawaPayService.failEnqueued('refunds', refund.id);
    return this.checkRefund(refund.id);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcilePending(): Promise<void> {
    if (
      this.reconciling ||
      !this.pawaPayService.isConfigured() ||
      this.configService.get<string>('PAWAPAY_RECONCILIATION_ENABLED') ===
        'false'
    )
      return;
    this.reconciling = true;
    try {
      const cutoff = new Date(Date.now() - 60_000);
      const payments = await this.paymentRepository.find({
        where: {
          provider: PaymentProvider.PAWAPAY,
          status: In([PaymentStatus.PENDING, PaymentStatus.INITIATED]),
          updatedAt: LessThan(cutoff),
        },
        order: { updatedAt: 'ASC' },
        take: 50,
      });
      for (const payment of payments) {
        if (!payment.orderNumber) continue;
        try {
          await this.paymentsService.checkPaymentStatus(payment.orderNumber);
        } catch (error) {
          this.logger.warn(
            `Réconciliation PawaPay paiement ${payment.id}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
      const refunds = await this.refundRepository.find({
        where: {
          status: In([
            PawaPayRefundStatus.CREATED,
            PawaPayRefundStatus.INITIATED,
          ]),
          updatedAt: LessThan(cutoff),
        },
        order: { updatedAt: 'ASC' },
        take: 50,
      });
      for (const refund of refunds) {
        try {
          await this.checkRefund(refund.id);
        } catch (error) {
          this.logger.warn(
            `Réconciliation PawaPay remboursement ${refund.id}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async getPawaPayPayment(id: string): Promise<PaymentTransaction> {
    const payment = await this.paymentRepository.findOneBy({ id });
    if (!payment || payment.provider !== PaymentProvider.PAWAPAY)
      throw new NotFoundException('Transaction PawaPay introuvable');
    return payment;
  }

  private isPayout(payment: PaymentTransaction): boolean {
    return [
      PaymentPurpose.DRIVER_PAYOUT,
      PaymentPurpose.WALLET_PAYOUT,
      PaymentPurpose.REFERRAL_PAYOUT,
    ].includes(payment.purpose as PaymentPurpose);
  }

  private async applyRefundSnapshot(
    refund: PawaPayRefund,
    snapshot: PawaPayPaymentSnapshot,
  ): Promise<PawaPayRefund> {
    if (snapshot.status === 'NOT_FOUND') {
      return this.commitRefund(refund.id, { rawCheckResponse: snapshot.raw });
    }
    if (snapshot.paymentId !== refund.id)
      throw new BadRequestException(
        'Identifiant de remboursement PawaPay incohérent',
      );
    const payment = await this.getPawaPayPayment(refund.paymentTransactionId);
    const rawData = (
      snapshot.raw.status === 'FOUND' ? snapshot.raw.data : snapshot.raw
    ) as Record<string, unknown>;
    if (rawData.depositId && rawData.depositId !== payment.orderNumber) {
      throw new BadRequestException(
        'Dépôt du remboursement PawaPay incohérent',
      );
    }
    if (
      snapshot.clientReferenceId &&
      snapshot.clientReferenceId !== payment.reference
    ) {
      throw new BadRequestException(
        'Référence du remboursement PawaPay incohérente',
      );
    }
    if (
      snapshot.status === 'COMPLETED' &&
      (Number(snapshot.amount) !== Number(refund.amount) ||
        snapshot.currency?.toUpperCase() !== refund.currency.toUpperCase())
    ) {
      throw new BadRequestException(
        'Montant ou devise du remboursement PawaPay incohérent',
      );
    }
    const status =
      snapshot.status === 'COMPLETED'
        ? PawaPayRefundStatus.COMPLETED
        : ['FAILED', 'REJECTED'].includes(snapshot.status)
          ? PawaPayRefundStatus.FAILED
          : PawaPayRefundStatus.INITIATED;
    return this.commitRefund(refund.id, {
      status,
      providerStatusCode: snapshot.status,
      providerMessage: snapshot.failureMessage,
      rawCheckResponse: snapshot.raw,
      completedAt:
        status === PawaPayRefundStatus.COMPLETED
          ? new Date()
          : refund.completedAt,
    });
  }

  private async commitRefund(
    id: string,
    patch: Partial<PawaPayRefund>,
  ): Promise<PawaPayRefund> {
    return this.refundRepository.manager.transaction(async (manager) => {
      const current = await manager.findOne(PawaPayRefund, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current)
        throw new NotFoundException('Remboursement PawaPay introuvable');
      if (current.status === PawaPayRefundStatus.COMPLETED) return current;
      if (
        current.status === PawaPayRefundStatus.FAILED &&
        patch.status &&
        patch.status !== PawaPayRefundStatus.FAILED
      ) {
        throw new BadGatewayException(
          'Remboursement PawaPay contradictoire : rapprochement manuel requis',
        );
      }
      return manager.save(PawaPayRefund, Object.assign(current, patch));
    });
  }
}
