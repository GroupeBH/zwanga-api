import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { DataSource, EntityManager, In } from 'typeorm';
import { PaymentsService } from '../payments/payments.service';
import {
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { FlexPayCallbackDto } from '../payments/dto/payment.dto';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { WalletService } from './wallet.service';
import {
  WalletAccount,
  WalletAccountType,
} from './entities/wallet-account.entity';
import {
  WalletLedgerEntry,
  WalletLedgerEntryType,
} from './entities/wallet-ledger-entry.entity';
import { WalletWithdrawal } from './entities/wallet-withdrawal.entity';
import { RequestWalletWithdrawalDto } from './dto/wallet.dto';
import { applyTokenMovement, tokenCents } from './wallet-origin';

const RELATED_TYPE = 'wallet_withdrawal';

@Injectable()
export class WalletWithdrawalsService implements OnModuleInit {
  private readonly logger = new Logger(WalletWithdrawalsService.name);
  private reconciling = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly payments: PaymentsService,
    private readonly wallet: WalletService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    this.payments.registerSettlement?.(
      PaymentPurpose.WALLET_PAYOUT,
      async (payment) => {
        await this.settle(payment);
      },
    );
  }

  async request(userId: string, dto: RequestWalletWithdrawalDto) {
    const phone = dto.phone?.replace(/^\+/, '');
    if (
      !/^243\d{9}$/.test(phone ?? '') ||
      !dto.idempotencyKey ||
      tokenCents(dto.tokens) < 100 ||
      dto.tokens > 1_000_000 ||
      tokenCents(dto.tokens) / 100 !== dto.tokens
    ) {
      throw new BadRequestException('Demande de retrait invalide');
    }
    // A retry may read the original request even when the rollout switch is off.
    const existing = await this.dataSource
      .getRepository(WalletWithdrawal)
      .findOne({ where: { userId, idempotencyKey: dto.idempotencyKey } });
    if (existing) {
      this.assertSameRequest(existing, dto.tokens, phone);
      return this.get(userId, existing.id);
    }
    if (this.config.get<string>('WALLET_WITHDRAWALS_ENABLED') !== 'true') {
      throw new BadRequestException(
        'Le retrait des jetons achetés n’est pas encore activé',
      );
    }
    const callbackUrl = this.callbackUrl();
    const summary = await this.wallet.getSummary(userId);
    const { currency, moneyPerToken } = summary.withdrawal;
    const amount = this.wallet.convertPointsToMoney(dto.tokens, currency);
    if (
      !['CDF', 'USD'].includes(currency) ||
      amount <= 0 ||
      amount > 99_999_999.99
    ) {
      throw new BadRequestException('Montant ou devise de retrait invalide');
    }

    const { withdrawal, created } = await this.dataSource
      .transaction(async (manager) => {
        // Consistent order: user -> account -> withdrawal. No network call under locks.
        const user = await manager.findOne(User, {
          where: { id: userId },
          select: { id: true, isActive: true, status: true },
          lock: { mode: 'pessimistic_write' },
        });
        const account = await this.lockAccount(manager, userId);
        const duplicate = await manager.findOne(WalletWithdrawal, {
          where: { userId, idempotencyKey: dto.idempotencyKey },
        });
        if (duplicate) {
          this.assertSameRequest(duplicate, dto.tokens, phone);
          return { withdrawal: duplicate, created: false };
        }
        if (
          !user?.isActive ||
          [UserStatus.INACTIVE, UserStatus.SUSPENDED].includes(user.status)
        ) {
          throw new BadRequestException('Compte indisponible pour un retrait');
        }
        if (
          !(await manager.exists(KycDocument, {
            where: { userId, status: KycStatus.APPROVED },
          }))
        ) {
          throw new BadRequestException(
            'Votre identité doit être vérifiée avant tout retrait',
          );
        }
        applyTokenMovement(account, -dto.tokens, 0, true);
        account.reservedWithdrawalBalance =
          (tokenCents(account.reservedWithdrawalBalance) +
            tokenCents(dto.tokens)) /
          100;
        await manager.save(account);
        const withdrawal = await manager.save(
          manager.create(WalletWithdrawal, {
            userId,
            idempotencyKey: dto.idempotencyKey,
            tokens: dto.tokens,
            amount,
            currency,
            moneyPerToken,
            phone,
            status: 'pending',
            paymentTransactionId: null,
            processedAt: null,
            releasedAt: null,
          }),
        );
        await this.ledger(manager, account, withdrawal, false);
        return { withdrawal, created: true };
      })
      .catch((error: unknown) => {
        // Only a proven rollback before submission permits the mobile app to
        // discard its persisted intent. Transport/database failures stay uncertain.
        if (error instanceof BadRequestException)
          throw new BadRequestException({
            code: 'WALLET_WITHDRAWAL_NOT_RESERVED',
            message: error.message,
          });
        throw error;
      });
    // Only the transaction which created the reservation may submit to FlexPay.
    // Crashes/unknown delivery must NEVER cause automatic resubmission.
    if (!created) return this.format(withdrawal);
    let payment: PaymentTransaction;
    try {
      payment = await this.payments.initiatePayout({
        userId,
        purpose: PaymentPurpose.WALLET_PAYOUT,
        relatedEntityType: RELATED_TYPE,
        relatedEntityId: withdrawal.id,
        phone,
        amount,
        currency,
        description: `Retrait de ${dto.tokens} jetons achetés Zwanga`,
        callbackUrl,
        referencePrefix: 'WDR',
      });
    } catch (error) {
      const recorded = await this.findPayment(withdrawal);
      if (recorded) return this.format(await this.settle(recorded), recorded);
      // PaymentsService persists its transaction BEFORE any external submission.
      await this.releaseUnsent(withdrawal);
      throw error;
    }
    return this.format(await this.settle(payment), payment);
  }

  async list(userId: string) {
    const withdrawals = await this.dataSource
      .getRepository(WalletWithdrawal)
      .find({ where: { userId }, order: { createdAt: 'DESC' }, take: 50 });
    return Promise.all(
      withdrawals.map((withdrawal) => this.format(withdrawal)),
    );
  }

  async get(userId: string, id: string) {
    const withdrawal = await this.dataSource
      .getRepository(WalletWithdrawal)
      .findOne({ where: { id, userId } });
    if (!withdrawal) throw new NotFoundException('Retrait introuvable');
    let payment = await this.findPayment(withdrawal);
    if (!payment) return this.format(withdrawal);
    if (
      payment.orderNumber &&
      [PaymentStatus.PENDING, PaymentStatus.INITIATED].includes(payment.status)
    ) {
      payment = await this.payments.checkPaymentStatus(
        payment.orderNumber,
        userId,
      );
    }
    return this.format(await this.settle(payment), payment);
  }

  async callback(dto: FlexPayCallbackDto) {
    const payment = await this.payments.handleFlexPayCallback(dto);
    await this.settle(payment);
    // No user wallet, phone or payout details in the public callback response.
    return { received: true };
  }

  @Cron('*/5 * * * *')
  async reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const pending = await this.dataSource
        .getRepository(WalletWithdrawal)
        .find({
          where: { status: In(['pending', 'initiated']) },
          order: { updatedAt: 'ASC' },
          take: 50,
        });
      for (const withdrawal of pending) {
        try {
          await this.get(withdrawal.userId, withdrawal.id);
        } catch {
          this.logger.warn(
            `WALLET_WITHDRAWAL_RECONCILIATION_PENDING id=${withdrawal.id}`,
          );
        }
        // Rotate unresolved rows so that old, order-less submissions don't starve newer ones.
        await this.dataSource
          .getRepository(WalletWithdrawal)
          .update(withdrawal.id, { updatedAt: new Date() });
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async settle(input: PaymentTransaction): Promise<WalletWithdrawal> {
    if (
      input.purpose !== PaymentPurpose.WALLET_PAYOUT ||
      input.relatedEntityType !== RELATED_TYPE ||
      !input.userId ||
      !input.relatedEntityId
    ) {
      throw new BadRequestException(
        'Cette transaction ne correspond pas à un retrait de jetons',
      );
    }
    return this.dataSource.transaction(async (manager) => {
      const account = await this.lockAccount(manager, input.userId!);
      const withdrawal = await manager.findOne(WalletWithdrawal, {
        where: { id: input.relatedEntityId!, userId: input.userId! },
        lock: { mode: 'pessimistic_write' },
      });
      // Re-read to avoid applying a stale pending/failed result after a success callback.
      const payment = await manager.findOne(PaymentTransaction, {
        where: { id: input.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !withdrawal ||
        !payment ||
        payment.userId !== withdrawal.userId ||
        payment.purpose !== PaymentPurpose.WALLET_PAYOUT ||
        payment.relatedEntityType !== RELATED_TYPE ||
        payment.relatedEntityId !== withdrawal.id ||
        tokenCents(payment.amount) !== tokenCents(withdrawal.amount) ||
        payment.currency !== withdrawal.currency ||
        payment.phone !== withdrawal.phone ||
        (withdrawal.paymentTransactionId &&
          withdrawal.paymentTransactionId !== payment.id)
      ) {
        throw new BadRequestException('Transaction de retrait incohérente');
      }
      if (['succeeded', 'review'].includes(withdrawal.status))
        return withdrawal;
      withdrawal.paymentTransactionId = payment.id;
      if (withdrawal.releasedAt) {
        if (payment.status === PaymentStatus.SUCCEEDED) {
          account.withdrawalsBlocked = true;
          withdrawal.status = 'review';
          await manager.save(account);
          this.logger.error(
            `WALLET_WITHDRAWAL_LATE_SUCCESS_REVIEW id=${withdrawal.id}`,
          );
        }
        return manager.save(withdrawal);
      }
      if (
        [
          PaymentStatus.SUCCEEDED,
          PaymentStatus.FAILED,
          PaymentStatus.CANCELLED,
        ].includes(payment.status)
      ) {
        account.reservedWithdrawalBalance =
          (tokenCents(account.reservedWithdrawalBalance) -
            tokenCents(withdrawal.tokens)) /
          100;
        if (payment.status !== PaymentStatus.SUCCEEDED) {
          applyTokenMovement(
            account,
            Number(withdrawal.tokens),
            Number(withdrawal.tokens),
          );
          withdrawal.releasedAt = new Date();
          await this.ledger(manager, account, withdrawal, true);
        }
        withdrawal.processedAt = new Date();
        await manager.save(account);
      }
      withdrawal.status = payment.status;
      return manager.save(withdrawal);
    });
  }

  private async releaseUnsent(input: WalletWithdrawal) {
    await this.dataSource.transaction(async (manager) => {
      const account = await this.lockAccount(manager, input.userId);
      const withdrawal = await manager.findOneOrFail(WalletWithdrawal, {
        where: { id: input.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        withdrawal.releasedAt ||
        withdrawal.paymentTransactionId ||
        withdrawal.status !== 'pending'
      )
        return;
      if (
        await manager.exists(PaymentTransaction, {
          where: { relatedEntityType: RELATED_TYPE, relatedEntityId: input.id },
        })
      )
        return;
      applyTokenMovement(
        account,
        Number(withdrawal.tokens),
        Number(withdrawal.tokens),
      );
      account.reservedWithdrawalBalance =
        (tokenCents(account.reservedWithdrawalBalance) -
          tokenCents(withdrawal.tokens)) /
        100;
      withdrawal.releasedAt = new Date();
      withdrawal.processedAt = new Date();
      withdrawal.status = 'failed';
      await manager.save(account);
      await manager.save(withdrawal);
      await this.ledger(manager, account, withdrawal, true);
    });
  }

  private async lockAccount(manager: EntityManager, userId: string) {
    const account = await manager.findOne(WalletAccount, {
      where: { userId, type: WalletAccountType.POINTS },
      lock: { mode: 'pessimistic_write' },
    });
    if (!account) throw new NotFoundException('Portefeuille introuvable');
    return account;
  }

  private async ledger(
    manager: EntityManager,
    account: WalletAccount,
    withdrawal: WalletWithdrawal,
    refund: boolean,
  ) {
    const amount = Number(withdrawal.tokens) * (refund ? 1 : -1);
    await manager.save(
      manager.create(WalletLedgerEntry, {
        accountId: account.id,
        userId: account.userId,
        accountType: account.type,
        currency: account.currency,
        type: refund
          ? WalletLedgerEntryType.WITHDRAWAL_REFUND
          : WalletLedgerEntryType.WITHDRAWAL,
        amount,
        withdrawableAmount: amount,
        balanceAfter: account.balance,
        relatedEntityType: RELATED_TYPE,
        relatedEntityId: withdrawal.id,
        paymentTransactionId: withdrawal.paymentTransactionId,
        description: refund
          ? 'Jetons restitués après échec du retrait'
          : 'Jetons achetés réservés pour un retrait Mobile Money',
      }),
    );
  }

  private findPayment(withdrawal: WalletWithdrawal) {
    return this.payments.findLatestTransactionForRelatedEntity(
      RELATED_TYPE,
      withdrawal.id,
      withdrawal.userId,
    );
  }

  private assertSameRequest(
    withdrawal: WalletWithdrawal,
    tokens: number,
    phone: string,
  ) {
    if (
      tokenCents(withdrawal.tokens) !== tokenCents(tokens) ||
      withdrawal.phone !== phone
    ) {
      throw new ConflictException(
        'Cette référence de retrait a déjà été utilisée avec un autre montant ou numéro',
      );
    }
  }

  private async format(
    withdrawal: WalletWithdrawal,
    knownPayment?: PaymentTransaction,
  ) {
    const payment = knownPayment ?? (await this.findPayment(withdrawal));
    return {
      id: withdrawal.id,
      idempotencyKey: withdrawal.idempotencyKey,
      tokens: Number(withdrawal.tokens),
      amount: Number(withdrawal.amount),
      currency: withdrawal.currency,
      moneyPerToken: Number(withdrawal.moneyPerToken),
      phone: withdrawal.phone,
      status: withdrawal.status,
      createdAt: withdrawal.createdAt,
      orderNumber: payment?.orderNumber ?? null,
      message:
        withdrawal.status === 'review'
          ? 'Ce retrait nécessite une vérification. Contactez le support.'
          : withdrawal.status === 'succeeded'
            ? 'Le montant de vos jetons a été versé sur votre compte Mobile Money.'
            : ['failed', 'cancelled'].includes(withdrawal.status)
              ? 'Le retrait n’a pas abouti. Vos jetons retirables ont été restitués.'
              : 'Retrait en cours de vérification. Les jetons sont réservés ; ne créez pas une nouvelle demande.',
    };
  }

  private callbackUrl() {
    const base =
      this.config.get<string>('FLEXPAY_CALLBACK_BASE_URL')?.trim() ||
      this.config.get<string>('PUBLIC_API_BASE_URL')?.trim();
    if (!base || !/^https:\/\//.test(base))
      throw new BadRequestException(
        'URL publique HTTPS des notifications de retrait non configurée',
      );
    return `${base.replace(/\/+$/, '')}/wallet/withdrawals/flexpay/callback`;
  }
}
