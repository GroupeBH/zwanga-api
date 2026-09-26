import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { randomBytes, randomUUID } from 'crypto';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';
import { FlexPayCallbackDto, PawaPayCallbackDto } from './dto/payment.dto';
import {
  FlexPayCheckTransactionResult,
  FlexPayInitiatePaymentResult,
  FlexPayService,
  FlexPayTransactionStatus,
} from './flexpay.service';
import {
  PawaPayCallbackKind,
  PawaPayPaymentSnapshot,
  PawaPayService,
} from './pawapay.service';
import {
  canFailoverPaymentProvider,
  PaymentGatewayUnavailableError,
  isUncertainProviderDelivery,
  parseEnabledPaymentProviders,
  parsePaymentProvider,
  resolvePaymentProviders,
} from './payment-provider.policy';
import { PaymentSettlementRegistry } from './payment-settlement.registry';
import { assertPawaPaySnapshotMatches, commitPawaPayState } from './pawapay-payment-state';
import { formatPaymentLogPayload } from './payment-log.util';
import { getPayoutFailureMessage, PAYOUT_MESSAGES } from './payout-policy';
import { hasVerifiedWalletTopUpProof } from './wallet-topup-proof';
import { assertWalletTopUpCheckEvidence } from './wallet-topup-check-evidence';
import { loadPaymentHistoryPage, loadPaymentHistorySummary } from './payment-history-page';
import { loadPaymentContext, PaymentContextDto } from './payment-context';
import type { PaymentHistoryPageDto } from '../common/pagination/history-page';

export interface InitiatePaymentInput {
  userId?: string | null;
  purpose?: string;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  method: PaymentMethod;
  phone?: string;
  amount: number;
  currency: string;
  description: string;
  callbackUrl?: string;
  approveUrl?: string;
  cancelUrl?: string;
  declineUrl?: string;
  referencePrefix?: string;
  preferredProvider?: PaymentProvider | null;
  pawaPayOperator?: string;
}

export interface InitiatePayoutInput {
  userId: string;
  purpose?: string;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  phone: string;
  amount: number;
  currency: string;
  description: string;
  callbackUrl?: string;
  referencePrefix?: string;
  preferredProvider?: PaymentProvider | null;
  pawaPayOperator?: string;
}

export interface NormalizedFlexPayCallback {
  code: string;
  reference: string;
  message: string | null;
  providerReference: string | null;
  orderNumber: string | null;
  raw: Record<string, unknown>;
}

export interface PaymentHistoryItem {
  id: string;
  purpose: string;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  provider: PaymentProvider;
  method: PaymentMethod;
  status: PaymentStatus;
  reference: string;
  orderNumber: string | null;
  providerReference: string | null;
  statusCode: string | null;
  message: string | null;
  amount: number;
  currency: string;
  description: string | null;
  phone: string | null;
  paymentUrl: string | null;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly MAX_FLEXPAY_REFERENCE_LENGTH = 25;

  constructor(
    @InjectRepository(PaymentTransaction)
    private readonly paymentTransactionRepository: Repository<PaymentTransaction>,
    private readonly configService: ConfigService,
    private readonly flexPayService: FlexPayService,
    private readonly pawaPayService: PawaPayService,
    private readonly settlementRegistry: PaymentSettlementRegistry,
  ) {}

  registerSettlement(
    purpose: string,
    handler: (payment: PaymentTransaction) => Promise<unknown>,
  ): void {
    this.settlementRegistry?.register(purpose, handler);
  }

  listPaymentProviders() {
    const enabled = this.getEnabledProviders();
    const primary =
      parsePaymentProvider(
        this.configService.get<string>('PAYMENT_PRIMARY_PROVIDER'),
      ) ?? PaymentProvider.FLEXPAY;
    const pawaPayConfigured = this.pawaPayService?.isConfigured() ?? false;
    const pawaPayDepositsEnabled = this.configService.get<string>('PAWAPAY_DEPOSITS_ENABLED') === 'true';
    const pawaPayPayoutsEnabled = this.configService.get<string>('PAWAPAY_PAYOUTS_ENABLED') === 'true';
    const providers = [
      {
        id: PaymentProvider.FLEXPAY,
        name: 'FlexPay',
        methods: [PaymentMethod.MOBILE_MONEY, PaymentMethod.CARD],
        configured: enabled.includes(PaymentProvider.FLEXPAY),
      },
      {
        id: PaymentProvider.PAWAPAY,
        name: 'PawaPay',
        methods: [PaymentMethod.MOBILE_MONEY],
        configured: pawaPayConfigured && pawaPayDepositsEnabled && enabled.includes(PaymentProvider.PAWAPAY),
        depositsEnabled: pawaPayConfigured && pawaPayDepositsEnabled && enabled.includes(PaymentProvider.PAWAPAY),
        payoutsEnabled: pawaPayConfigured && pawaPayPayoutsEnabled && enabled.includes(PaymentProvider.PAWAPAY),
      },
    ];
    const available = resolvePaymentProviders({
      method: PaymentMethod.MOBILE_MONEY,
      primary,
      enabled,
      pawaPayConfigured: pawaPayConfigured && pawaPayDepositsEnabled,
    });

    return {
      providers,
      primary: available[0] ?? primary,
      fallback: available[1] ?? null,
      callbacks: {
        flexpay: {
          generic: this.getGenericFlexPayCallbackUrl(),
        },
        pawapay: {
          deposits: this.getPawaPayCallbackUrl('deposits'),
          payouts: this.getPawaPayCallbackUrl('payouts'),
          refunds: this.getPawaPayCallbackUrl('refunds'),
        },
        returnUrls: {
          success: this.getCustomerReturnUrl('success'),
          failed: this.getCustomerReturnUrl('failed'),
        },
      },
    };
  }

  async initiatePayment(
    input: InitiatePaymentInput,
  ): Promise<PaymentTransaction> {
    this.ensurePaymentInputIsUsable(input);
    const providers = this.resolveProviders(input.method, 'deposits', input.preferredProvider);
    if (providers.length === 0) {
      throw new BadRequestException(
        "Aucun prestataire de paiement n'est disponible",
      );
    }

    const transaction = this.paymentTransactionRepository.create({
      userId: input.userId ?? null,
      purpose: input.purpose || PaymentPurpose.GENERIC,
      relatedEntityType: input.relatedEntityType ?? null,
      relatedEntityId: input.relatedEntityId ?? null,
      provider: providers[0],
      method: input.method,
      status: PaymentStatus.PENDING,
      reference: this.generatePaymentReference(
        input.referencePrefix,
        input.userId,
      ),
      orderNumber: null,
      providerReference: null,
      providerStatusCode: null,
      providerMessage: null,
      amount: input.amount,
      currency: input.currency.toUpperCase(),
      description: input.description,
      phone: input.method === PaymentMethod.MOBILE_MONEY ? input.phone : null,
      paymentUrl: null,
      callbackUrl: this.getProviderCallbackUrl(
        providers[0],
        'deposits',
        input.callbackUrl,
      ),
      rawInitiationResponse: null,
      rawCallbackPayload: null,
      rawCheckResponse: null,
      paidAt: null,
    });

    let savedTransaction =
      await this.paymentTransactionRepository.save(transaction);
    this.logger.warn(
      `Payment transaction created: id=${savedTransaction.id}, reference=${savedTransaction.reference}, userId=${savedTransaction.userId ?? 'anonymous'}, purpose=${savedTransaction.purpose}, method=${savedTransaction.method}, amount=${savedTransaction.amount} ${savedTransaction.currency}, related=${savedTransaction.relatedEntityType ?? 'none'}:${savedTransaction.relatedEntityId ?? 'none'}`,
    );

    let lastError: unknown;
    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index];
      if (index > 0) {
        this.resetProviderAttempt(
          savedTransaction,
          provider,
          'deposits',
          input.callbackUrl,
        );
        savedTransaction =
          await this.paymentTransactionRepository.save(savedTransaction);
      }
      this.logger.warn(
        `Starting ${provider} initiation: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, method=${savedTransaction.method}`,
      );

      try {
        return provider === PaymentProvider.PAWAPAY
          ? await this.initiatePawaPayDeposit(savedTransaction, input)
          : await this.initiateFlexPayDeposit(savedTransaction, input);
      } catch (error) {
        lastError = error;
        const canFailover =
          index < providers.length - 1 && canFailoverPaymentProvider(error);
        if (canFailover) {
          this.logger.warn(
            `Deposit failover from ${provider} to ${providers[index + 1]}: paymentId=${savedTransaction.id}, message=${this.getErrorMessage(error)}`,
          );
          continue;
        }
        if (isUncertainProviderDelivery(error)) {
          return this.persistFailedInitiation(savedTransaction, error, true);
        }
        await this.persistFailedInitiation(savedTransaction, error, false);
        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new BadRequestException("Le paiement n'a pas pu être initialisé");
  }

  async initiatePayout(
    input: InitiatePayoutInput,
  ): Promise<PaymentTransaction> {
    this.ensurePayoutInputIsUsable(input);
    const providers = this.resolveProviders(
      PaymentMethod.MOBILE_MONEY,
      'payouts',
      input.preferredProvider,
    );
    if (providers.length === 0) {
      throw new BadRequestException(
        "Aucun prestataire de versement n'est disponible",
      );
    }

    const transaction = this.paymentTransactionRepository.create({
      userId: input.userId,
      purpose: input.purpose || PaymentPurpose.DRIVER_PAYOUT,
      relatedEntityType: input.relatedEntityType ?? null,
      relatedEntityId: input.relatedEntityId ?? null,
      provider: providers[0],
      method: PaymentMethod.MOBILE_MONEY,
      status: PaymentStatus.PENDING,
      reference: this.generatePaymentReference(
        input.referencePrefix,
        input.userId,
      ),
      orderNumber: null,
      providerReference: null,
      providerStatusCode: null,
      providerMessage: null,
      amount: input.amount,
      currency: input.currency.toUpperCase(),
      description: input.description,
      phone: input.phone,
      paymentUrl: null,
      callbackUrl: this.getProviderCallbackUrl(
        providers[0],
        'payouts',
        input.callbackUrl,
      ),
      rawInitiationResponse: null,
      rawCallbackPayload: null,
      rawCheckResponse: null,
      paidAt: null,
    });

    let savedTransaction =
      await this.paymentTransactionRepository.save(transaction);
    this.logger.warn(
      `Payout transaction created: id=${savedTransaction.id}, reference=${savedTransaction.reference}, userId=${savedTransaction.userId}, amount=${savedTransaction.amount} ${savedTransaction.currency}, related=${savedTransaction.relatedEntityType ?? 'none'}:${savedTransaction.relatedEntityId ?? 'none'}`,
    );

    let lastError: unknown;
    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index];
      if (index > 0) {
        this.resetProviderAttempt(
          savedTransaction,
          provider,
          'payouts',
          input.callbackUrl,
        );
        savedTransaction =
          await this.paymentTransactionRepository.save(savedTransaction);
      }

      try {
        return provider === PaymentProvider.PAWAPAY
          ? await this.initiatePawaPayPayout(savedTransaction, input)
          : await this.initiateFlexPayPayout(savedTransaction, input);
      } catch (error) {
        lastError = error;
        const canFailover =
          index < providers.length - 1 &&
          canFailoverPaymentProvider(error);
        if (canFailover) {
          this.logger.warn(
            `Payout failover from ${provider} to ${providers[index + 1]}: paymentId=${savedTransaction.id}, message=${this.getErrorMessage(error)}`,
          );
          continue;
        }

        const deliveryIsUncertain = isUncertainProviderDelivery(error);
        savedTransaction = await this.persistFailedInitiation(
          savedTransaction,
          error,
          deliveryIsUncertain,
        );
        this.logger.error(
          `Payout initiation failed: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, message=${this.getErrorMessage(error)}`,
          this.getErrorStack(error),
        );
        if (deliveryIsUncertain) {
          return savedTransaction;
        }
        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new BadRequestException("Le versement n'a pas pu être initialisé");
  }

  async handleFlexPayCallback(
    dto: FlexPayCallbackDto,
  ): Promise<PaymentTransaction> {
    const callback = this.normalizeFlexPayCallback(dto);
    this.logger.warn(
      `FlexPay callback received: reference=${callback.reference}, orderNumber=${callback.orderNumber ?? 'none'}, code=${callback.code}, providerReference=${callback.providerReference ?? 'none'}, payload=${formatPaymentLogPayload(callback.raw)}`,
    );

    const transaction = await this.findTransactionByReferenceOrOrderNumber(
      callback.reference,
      callback.orderNumber ?? undefined,
    );
    const previousStatus = transaction.status;
    if (transaction.provider === PaymentProvider.PAWAPAY) {
      throw new BadRequestException('Cette transaction ne dépend pas de FlexPay');
    }
    if (
      (this.isPayoutTransaction(transaction) ||
        transaction.purpose === PaymentPurpose.WALLET_TOP_UP) &&
      (callback.reference !== transaction.reference ||
        (transaction.orderNumber &&
          callback.orderNumber &&
          transaction.orderNumber !== callback.orderNumber))
    ) {
      throw new BadRequestException(
        'La notification FlexPay ne correspond pas à ce versement',
      );
    }
    const callbackSucceeded = this.flexPayService.isSuccessfulCode(
      callback.code,
    );

    if (
      transaction.purpose === PaymentPurpose.WALLET_TOP_UP &&
      !transaction.orderNumber
    ) {
      throw new BadRequestException(
        'La recharge doit posséder un numéro de commande confirmé par FlexPay',
      );
    }

    this.logger.warn(
      `FlexPay callback matched payment: paymentId=${transaction.id}, reference=${transaction.reference}, previousStatus=${previousStatus}, orderNumber=${transaction.orderNumber ?? 'none'}`,
    );

    if (!callbackSucceeded && previousStatus === PaymentStatus.SUCCEEDED) {
      this.logger.warn(
        `Ignoring non-success FlexPay callback for already succeeded payment: paymentId=${transaction.id}, reference=${transaction.reference}, code=${callback.code}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(transaction))}`,
      );
      return transaction;
    }

    if (this.isPayoutTransaction(transaction)) {
      return this.handleVerifiedPayoutCallback(transaction, callback);
    }

    transaction.providerStatusCode = callback.code;
    transaction.providerReference =
      callback.providerReference ?? transaction.providerReference;
    transaction.orderNumber = callback.orderNumber ?? transaction.orderNumber;
    transaction.rawCallbackPayload = callback.raw;

    if (
      transaction.purpose === PaymentPurpose.WALLET_TOP_UP ||
      this.shouldVerifyFlexPayCallbacks()
    ) {
      if (!transaction.orderNumber) {
        transaction.providerMessage =
          'Notification de paiement reçue, mais le numéro de commande FlexPay est manquant';
        const savedTransaction =
          await this.paymentTransactionRepository.save(transaction);
        this.logger.warn(
          `FlexPay callback cannot be verified without orderNumber: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(savedTransaction))}`,
        );
        return savedTransaction;
      }

      try {
        return await this.checkTransactionAndApply(transaction);
      } catch (error) {
        const errorMessage = this.getErrorMessage(error);
        this.logger.warn(
          `FlexPay callback verification failed: paymentId=${transaction.id}, reference=${transaction.reference}, orderNumber=${transaction.orderNumber}, message=${errorMessage}`,
        );
        transaction.providerMessage =
          'Notification de paiement reçue. Vérification du paiement en cours';
        const savedTransaction =
          await this.paymentTransactionRepository.save(transaction);
        this.logger.warn(
          `FlexPay callback verification pending response: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(savedTransaction))}`,
        );
        return savedTransaction;
      }
    }

    if (!callbackSucceeded) {
      transaction.status = this.isCancellationMessage(callback.message)
        ? PaymentStatus.CANCELLED
        : PaymentStatus.FAILED;
      transaction.providerMessage = this.getCallbackFailureMessage(
        callback.message,
      );
      const savedTransaction =
        await this.paymentTransactionRepository.save(transaction);
      this.logger.warn(
        `Payment marked failed from FlexPay callback: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, previousStatus=${previousStatus}, code=${callback.code}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(savedTransaction))}`,
      );
      return savedTransaction;
    }

    transaction.status = PaymentStatus.SUCCEEDED;
    transaction.providerMessage = 'Paiement confirmé avec succès';
    transaction.paidAt = transaction.paidAt ?? new Date();
    const savedTransaction =
      await this.paymentTransactionRepository.save(transaction);
    this.logger.warn(
      `Payment confirmed from FlexPay callback: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, previousStatus=${previousStatus}, status=${savedTransaction.status}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(savedTransaction))}`,
    );
    return savedTransaction;
  }

  async handlePawaPayCallback(
    kind: PawaPayCallbackKind,
    dto: PawaPayCallbackDto | Record<string, unknown>,
  ): Promise<{ received: true; status: PaymentStatus; reference: string }> {
    // Refund callbacks are handled by PawaPayOperationsService, not as deposits.
    if (kind === 'refunds') {
      throw new BadRequestException('Utilisez le callback de remboursement PawaPay');
    }
    const callback = this.pawaPayService.normalizeCallback(
      kind,
      dto as Record<string, unknown>,
    );
    this.logger.warn(
      `PawaPay ${kind} callback received: paymentId=${callback.paymentId}, status=${callback.status}, reference=${callback.clientReferenceId ?? 'none'}, payload=${formatPaymentLogPayload(callback.raw)}`,
    );

    const transaction = await this.findTransactionByReferenceOrOrderNumber(
      callback.clientReferenceId ?? callback.paymentId,
      callback.paymentId,
    );
    if (transaction.provider !== PaymentProvider.PAWAPAY ||
        transaction.orderNumber !== callback.paymentId ||
        (callback.clientReferenceId && callback.clientReferenceId !== transaction.reference) ||
        (kind === 'payouts') !== this.isPayoutTransaction(transaction)) {
      throw new BadRequestException('La notification PawaPay ne correspond pas à cette transaction');
    }
    // Ignore the unsigned callback status, amount and identifiers as evidence.
    // A failed verification propagates: no HTTP 200 acknowledgement until it can be retried.
    const saved = await this.checkPawaPayTransactionAndApply(transaction);
    if (['COMPLETED', 'FAILED'].includes(callback.status) && !this.isTerminalPaymentStatus(saved.status)) {
      throw new BadGatewayException('La confirmation PawaPay doit être vérifiée à nouveau');
    }
    await this.settlementRegistry?.apply?.(saved);
    return {
      received: true,
      status: saved.status,
      reference: saved.reference,
    };
  }

  async checkPaymentStatus(
    orderNumber: string,
    userId?: string,
    forceProviderCheck = false,
  ): Promise<PaymentTransaction> {
    this.logger.warn(
      `Payment status check requested: orderNumber=${orderNumber}, userId=${userId ?? 'none'}`,
    );
    const transaction = await this.findTransactionByOrderNumber(
      orderNumber,
      userId,
    );
    this.logger.warn(
      `Payment status check matched payment: paymentId=${transaction.id}, reference=${transaction.reference}, currentStatus=${transaction.status}`,
    );

    const unverifiedLegacyTopUp =
      transaction.purpose === PaymentPurpose.WALLET_TOP_UP &&
      transaction.status === PaymentStatus.SUCCEEDED &&
      !hasVerifiedWalletTopUpProof(transaction);
    if (
      this.isTerminalPaymentStatus(transaction.status) &&
      !unverifiedLegacyTopUp &&
      !(forceProviderCheck && transaction.provider === PaymentProvider.PAWAPAY)
    ) {
      this.logger.warn(
        `Payment status check served from local terminal state: paymentId=${transaction.id}, status=${transaction.status}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(transaction))}`,
      );
      if (transaction.provider === PaymentProvider.PAWAPAY) {
        // Retry the business settlement if a previous callback saved the status
        // but failed before crediting the wallet/booking/subscription.
        await this.settlementRegistry.apply(transaction);
      }
      return transaction;
    }

    return this.checkTransactionAndApply(transaction);
  }

  async findUserTransactions(userId: string): Promise<PaymentTransaction[]> {
    this.logger.debug(`Fetching payment transactions for userId=${userId}`);

    return this.paymentTransactionRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async findUserTransactionPage(userId: string, options: PaymentHistoryPageDto) {
    const page = await loadPaymentHistoryPage(this.paymentTransactionRepository, userId, options);
    return { ...page, data: page.data.map(transaction => this.formatPaymentHistoryForClient(transaction)) };
  }

  async findUserPaymentContext(userId: string, context: PaymentContextDto) {
    const transactions = await loadPaymentContext(this.paymentTransactionRepository, userId, context);
    return transactions.map(transaction => this.formatPaymentHistoryForClient(transaction));
  }

  getUserTransactionSummary(userId: string) {
    return loadPaymentHistorySummary(this.paymentTransactionRepository, userId);
  }

  async findTransactionById(
    id: string,
    userId?: string,
  ): Promise<PaymentTransaction> {
    const transaction = await this.paymentTransactionRepository.findOne({
      where: {
        id,
        ...(userId ? { userId } : {}),
      },
    });

    if (!transaction) {
      throw new NotFoundException('Transaction de paiement introuvable');
    }

    return transaction;
  }

  async findLatestTransactionForRelatedEntity(
    relatedEntityType: string,
    relatedEntityId: string,
    userId?: string,
  ): Promise<PaymentTransaction | null> {
    return this.paymentTransactionRepository.findOne({
      where: {
        relatedEntityType,
        relatedEntityId,
        ...(userId ? { userId } : {}),
      },
      order: { createdAt: 'DESC' },
    });
  }

  isSuccessfulPayment(transaction: PaymentTransaction): boolean {
    return transaction.status === PaymentStatus.SUCCEEDED;
  }

  getClientPaymentMessage(
    transaction:
      | (Pick<
          PaymentTransaction,
          'status' | 'method' | 'paymentUrl' | 'providerMessage'
        > &
          Partial<Pick<PaymentTransaction, 'purpose' | 'orderNumber'>>)
      | null,
  ): string | null {
    if (!transaction) {
      return null;
    }

    if (this.isPayoutTransaction(transaction)) {
      if (transaction.status === PaymentStatus.SUCCEEDED)
        return 'Zwanga a versé vos gains sur votre compte Mobile Money.';
      if (transaction.status === PaymentStatus.CANCELLED)
        return 'Le versement a été annulé.';
      if (transaction.status === PaymentStatus.FAILED)
        return getPayoutFailureMessage(transaction.providerMessage);
      return transaction.orderNumber
        ? PAYOUT_MESSAGES.pending
        : PAYOUT_MESSAGES.review;
    }

    const translatedProviderMessage = this.translatePaymentMessage(
      transaction.providerMessage,
    );
    if (translatedProviderMessage) {
      return translatedProviderMessage;
    }

    switch (transaction.status) {
      case PaymentStatus.SUCCEEDED:
        return 'Paiement confirmé avec succès';
      case PaymentStatus.FAILED:
        return 'Le paiement a échoué';
      case PaymentStatus.CANCELLED:
        return 'Le paiement a été annulé';
      case PaymentStatus.INITIATED:
        if (transaction.paymentUrl) {
          return 'Redirection vers la page de paiement en cours';
        }
        if (transaction.method === PaymentMethod.MOBILE_MONEY) {
          return 'Demande de paiement envoyée. Veuillez valider sur votre téléphone';
        }
        return 'Paiement initialisé. Vérification en cours';
      case PaymentStatus.PENDING:
      default:
        return 'Paiement en attente de confirmation';
    }
  }

  formatPaymentForClient(transaction: PaymentTransaction): PaymentTransaction {
    return {
      ...transaction,
      providerMessage: this.getClientPaymentMessage(transaction),
    };
  }

  formatPaymentHistoryForClient(
    transaction: PaymentTransaction,
  ): PaymentHistoryItem {
    return {
      id: transaction.id,
      purpose: transaction.purpose,
      relatedEntityType: transaction.relatedEntityType,
      relatedEntityId: transaction.relatedEntityId,
      provider: transaction.provider,
      method: transaction.method,
      status: transaction.status,
      reference: transaction.reference,
      orderNumber: transaction.orderNumber,
      providerReference: transaction.providerReference,
      statusCode: transaction.providerStatusCode,
      message: this.getClientPaymentMessage(transaction),
      amount: Number(transaction.amount),
      currency: transaction.currency,
      description: transaction.description,
      phone: this.maskPaymentPhone(transaction.phone),
      paymentUrl: transaction.paymentUrl,
      paidAt: transaction.paidAt,
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
    };
  }

  formatPaymentLogResponse(
    transaction: PaymentTransaction | null,
  ): Record<string, unknown> | null {
    if (!transaction) {
      return null;
    }

    return {
      id: transaction.id,
      purpose: transaction.purpose,
      relatedEntityType: transaction.relatedEntityType,
      relatedEntityId: transaction.relatedEntityId,
      provider: transaction.provider,
      method: transaction.method,
      status: transaction.status,
      reference: transaction.reference,
      orderNumber: transaction.orderNumber,
      providerReference: transaction.providerReference,
      statusCode: transaction.providerStatusCode,
      message: this.getClientPaymentMessage(transaction),
      amount: Number(transaction.amount ?? 0),
      currency: transaction.currency,
      phone: this.maskPaymentPhone(transaction.phone),
      paymentUrl: transaction.paymentUrl,
      paidAt: transaction.paidAt,
    };
  }

  formatLogPayload(payload: unknown): string {
    return formatPaymentLogPayload(payload);
  }

  normalizeFlexPayCallback(dto: FlexPayCallbackDto): NormalizedFlexPayCallback {
    const raw = dto as Record<string, unknown>;
    const code = this.getStringValue(raw, 'code', 'Code');
    const reference = this.getStringValue(raw, 'reference', 'Reference');
    const message = this.getStringValue(raw, 'message', 'Message');
    const providerReference = this.getStringValue(
      raw,
      'provider_reference',
      'Provider_reference',
      'providerReference',
      'ProviderReference',
    );
    const orderNumber = this.getStringValue(
      raw,
      'orderNumber',
      'OrderNumber',
      'order_number',
    );

    if (!code || !reference) {
      throw new BadRequestException(
        'Le callback FlexPay doit contenir code et référence',
      );
    }

    return {
      code,
      reference,
      message,
      providerReference: providerReference ?? null,
      orderNumber,
      raw,
    };
  }

  private async checkTransactionAndApply(
    transaction: PaymentTransaction,
  ): Promise<PaymentTransaction> {
    if (transaction.provider === PaymentProvider.PAWAPAY) {
      const saved = await this.checkPawaPayTransactionAndApply(transaction);
      await this.settlementRegistry?.apply?.(saved);
      return saved;
    }

    if (!transaction.orderNumber) {
      throw new BadRequestException('Le numéro de commande FlexPay est requis');
    }

    this.logger.warn(
      `Checking FlexPay transaction: paymentId=${transaction.id}, reference=${transaction.reference}, orderNumber=${transaction.orderNumber}, currentStatus=${transaction.status}`,
    );

    const checkResult = this.isPayoutTransaction(transaction)
      ? await this.flexPayService.checkPayoutTransaction(
          transaction.orderNumber,
        )
      : await this.flexPayService.checkTransaction(transaction.orderNumber);
    this.logger.warn(
      `FlexPay check result received: paymentId=${transaction.id}, reference=${transaction.reference}, orderNumber=${transaction.orderNumber}, response=${formatPaymentLogPayload(checkResult.raw)}`,
    );

    return this.applyFlexPayCheckResult(transaction, checkResult);
  }

  private async applyFlexPayCheckResult(
    transaction: PaymentTransaction,
    checkResult: FlexPayCheckTransactionResult,
  ): Promise<PaymentTransaction> {
    if (this.isPayoutTransaction(transaction)) {
      return this.applyFlexPayPayoutCheckResult(transaction, checkResult);
    }
    const previousStatus = transaction.status;
    transaction.providerStatusCode =
      checkResult.transaction?.status ??
      checkResult.transaction?.code ??
      checkResult.code;
    transaction.rawCheckResponse = checkResult.raw;

    if (!this.flexPayService.isSuccessfulCode(checkResult.code)) {
      transaction.providerMessage = this.getCheckFailureMessage(
        checkResult.message,
      );
      const savedTransaction =
        await this.paymentTransactionRepository.save(transaction);
      this.logger.warn(
        `FlexPay check returned non-success code: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, code=${checkResult.code}, message=${checkResult.message ?? 'none'}, status=${savedTransaction.status}, providerResponse=${formatPaymentLogPayload(checkResult.raw)}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(savedTransaction))}`,
      );
      return savedTransaction;
    }

    const providerTransaction = checkResult.transaction;
    if (!providerTransaction) {
      transaction.providerMessage = this.getMissingTransactionMessage(
        checkResult.message,
      );
      const savedTransaction =
        await this.paymentTransactionRepository.save(transaction);
      this.logger.warn(
        `FlexPay check returned no transaction: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, orderNumber=${savedTransaction.orderNumber ?? 'none'}, providerResponse=${formatPaymentLogPayload(checkResult.raw)}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(savedTransaction))}`,
      );
      return savedTransaction;
    }

    const providerTransactionStatus =
      providerTransaction.status ?? providerTransaction.code;
    const providerSucceeded =
      this.flexPayService.isSuccessfulTransaction(providerTransaction);
    const providerFailed =
      !providerSucceeded &&
      (providerTransactionStatus === '1' ||
        this.isDeclinedPaymentMessage(checkResult.message));
    assertWalletTopUpCheckEvidence(
      transaction,
      providerTransaction,
      providerFailed,
    );

    const normalizedProviderReference = providerTransaction.reference?.trim();
    const normalizedTransactionReference = transaction.reference?.trim();
    const normalizedOrderNumber =
      providerTransaction.orderNumber?.trim() ??
      transaction.orderNumber?.trim();

    if (
      normalizedProviderReference &&
      normalizedProviderReference !== normalizedTransactionReference
    ) {
      if (normalizedProviderReference === normalizedOrderNumber) {
        this.logger.warn(
          `FlexPay check returned orderNumber in reference field: paymentId=${transaction.id}, expectedReference=${transaction.reference}, providerReference=${providerTransaction.reference}, orderNumber=${normalizedOrderNumber ?? 'none'}`,
        );
      } else {
        this.logger.warn(
          `FlexPay check reference mismatch: paymentId=${transaction.id}, expectedReference=${transaction.reference}, providerReference=${providerTransaction.reference}, orderNumber=${providerTransaction.orderNumber ?? transaction.orderNumber ?? 'none'}`,
        );
        throw new BadRequestException(
          'La référence FlexPay ne correspond pas à cette transaction',
        );
      }
    }

    this.assertProviderTransactionMatches(transaction, providerTransaction);

    transaction.orderNumber =
      providerTransaction.orderNumber ?? transaction.orderNumber;

    if (providerSucceeded) {
      transaction.status = PaymentStatus.SUCCEEDED;
      transaction.providerMessage = 'Paiement confirmé avec succès';
      transaction.paidAt = transaction.paidAt ?? new Date();
      const savedTransaction =
        await this.paymentTransactionRepository.save(transaction);
      this.logger.warn(
        `Payment confirmed from FlexPay check: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, previousStatus=${previousStatus}, status=${savedTransaction.status}, providerStatus=${providerTransactionStatus}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(savedTransaction))}`,
      );
      return savedTransaction;
    }

    if (providerFailed) {
      transaction.status = this.isCancellationMessage(checkResult.message)
        ? PaymentStatus.CANCELLED
        : PaymentStatus.FAILED;
      transaction.providerMessage = this.getCallbackFailureMessage(
        checkResult.message,
      );
    } else {
      transaction.providerMessage = this.getPendingPaymentMessage(
        checkResult.message,
      );
    }

    const savedTransaction =
      await this.paymentTransactionRepository.save(transaction);
    this.logger.warn(
      `Payment updated from FlexPay check: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, previousStatus=${previousStatus}, status=${savedTransaction.status}, providerStatus=${providerTransactionStatus ?? 'none'}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(savedTransaction))}`,
    );
    return savedTransaction;
  }

  private isPayoutTransaction(transaction: { purpose?: string }): boolean {
    return (
      transaction.purpose === PaymentPurpose.DRIVER_PAYOUT ||
      transaction.purpose === PaymentPurpose.WALLET_PAYOUT ||
      transaction.purpose === PaymentPurpose.REFERRAL_PAYOUT
    );
  }

  private async handleVerifiedPayoutCallback(
    transaction: PaymentTransaction,
    callback: NormalizedFlexPayCallback,
  ): Promise<PaymentTransaction> {
    if (transaction.status === PaymentStatus.SUCCEEDED) return transaction;
    transaction.rawCallbackPayload = callback.raw;
    transaction.providerMessage = PAYOUT_MESSAGES.pending;
    const orderNumber = transaction.orderNumber ?? callback.orderNumber;
    if (orderNumber) {
      try {
        const result =
          await this.flexPayService.checkPayoutTransaction(orderNumber);
        transaction.rawCheckResponse = result.raw;
        if (result.transaction) {
          // Do not persist an order number supplied only by an unverified webhook.
          return await this.applyFlexPayPayoutCheckResult(
            { ...transaction, orderNumber },
            result,
          );
        }
      } catch {
        this.logger.warn(
          `Payout callback verification pending: reference=${transaction.reference}`,
        );
      }
    }
    return this.paymentTransactionRepository.save(transaction);
  }

  private async applyFlexPayPayoutCheckResult(
    transaction: PaymentTransaction,
    checkResult: FlexPayCheckTransactionResult,
  ): Promise<PaymentTransaction> {
    if (transaction.status === PaymentStatus.SUCCEEDED) return transaction;
    transaction.rawCheckResponse = checkResult.raw;
    const provider = checkResult.transaction;
    transaction.providerStatusCode = provider?.status ?? checkResult.code;
    transaction.providerMessage = PAYOUT_MESSAGES.pending;
    if (!provider) return this.paymentTransactionRepository.save(transaction);

    // Payout checks omit amount/currency in v1.03, so both identifiers must match.
    if (
      !provider.reference?.trim() ||
      provider.reference.trim() !== transaction.reference ||
      !provider.orderNumber?.trim() ||
      provider.orderNumber.trim() !== transaction.orderNumber
    ) {
      throw new BadRequestException(
        'La référence FlexPay ne correspond pas à ce versement',
      );
    }
    this.assertProviderTransactionMatches(transaction, provider);
    if (checkResult.code === '0' && provider.status === '0') {
      transaction.status = PaymentStatus.SUCCEEDED;
      transaction.providerReference =
        provider.providerReference ?? transaction.providerReference;
      transaction.providerMessage = 'Versement confirmé avec succès';
      transaction.paidAt = transaction.paidAt ?? new Date();
    } else if (
      ['0', '1'].includes(checkResult.code) &&
      provider.status === '1'
    ) {
      transaction.status = this.isCancellationMessage(checkResult.message)
        ? PaymentStatus.CANCELLED
        : PaymentStatus.FAILED;
      transaction.providerMessage = getPayoutFailureMessage(
        checkResult.message,
      );
    }
    // A missing transaction, unknown status or inconsistent result is not a rejection.
    return this.paymentTransactionRepository.save(transaction);
  }

  private async findTransactionByReferenceOrOrderNumber(
    reference: string,
    orderNumber?: string,
  ): Promise<PaymentTransaction> {
    const transaction = await this.paymentTransactionRepository.findOne({
      where: { reference },
      order: { createdAt: 'DESC' },
    });

    if (transaction) {
      return transaction;
    }

    if (orderNumber) {
      const transactionByOrderNumber =
        await this.paymentTransactionRepository.findOne({
          where: { orderNumber },
          order: { createdAt: 'DESC' },
        });

      if (transactionByOrderNumber) {
        return transactionByOrderNumber;
      }
    }

    throw new NotFoundException('Transaction de paiement introuvable');
  }

  private async findTransactionByOrderNumber(
    orderNumber: string,
    userId?: string,
  ): Promise<PaymentTransaction> {
    const transaction = await this.paymentTransactionRepository.findOne({
      where: {
        orderNumber,
        ...(userId ? { userId } : {}),
      },
      order: { createdAt: 'DESC' },
    });

    if (!transaction) {
      throw new NotFoundException('Transaction de paiement introuvable');
    }

    return transaction;
  }

  private ensurePaymentInputIsUsable(input: InitiatePaymentInput): void {
    if (input.method === PaymentMethod.MOBILE_MONEY && !input.phone?.trim()) {
      throw new BadRequestException(
        'Le numéro de téléphone est requis pour payer par Mobile Money',
      );
    }

    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new BadRequestException('Le montant du paiement est invalide');
    }

    if (!input.currency?.trim()) {
      throw new BadRequestException('La devise du paiement est requise');
    }
  }

  private ensurePayoutInputIsUsable(input: InitiatePayoutInput): void {
    if (!input.userId?.trim()) {
      throw new BadRequestException('Le chauffeur est requis');
    }

    if (!input.phone?.trim()) {
      throw new BadRequestException(
        'Le numéro de téléphone est requis pour le paiement chauffeur',
      );
    }

    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new BadRequestException('Le montant du paiement est invalide');
    }

    if (!input.currency?.trim()) {
      throw new BadRequestException('La devise du paiement est requise');
    }
  }

  private assertProviderTransactionMatches(
    transaction: PaymentTransaction,
    providerTransaction: FlexPayTransactionStatus,
  ): void {
    const providerOrderNumber = providerTransaction.orderNumber?.trim();
    if (
      providerOrderNumber &&
      transaction.orderNumber &&
      providerOrderNumber !== transaction.orderNumber
    ) {
      throw new BadRequestException(
        'Le numéro de commande FlexPay ne correspond pas à cette transaction',
      );
    }

    const storedAmount = Number(transaction.amount);
    if (
      providerTransaction.amount !== null &&
      Number.isFinite(storedAmount) &&
      storedAmount > 0
    ) {
      const providerAmount = Number(providerTransaction.amount);
      if (
        !Number.isFinite(providerAmount) ||
        Math.round(providerAmount * 100) !== Math.round(storedAmount * 100)
      ) {
        throw new BadRequestException(
          'Le montant retourné par FlexPay ne correspond pas à cette transaction',
        );
      }
    }

    const providerCurrency = providerTransaction.currency?.trim().toUpperCase();
    if (
      providerCurrency &&
      transaction.currency?.trim() &&
      providerCurrency !== transaction.currency.trim().toUpperCase()
    ) {
      throw new BadRequestException(
        'La devise retournée par FlexPay ne correspond pas à cette transaction',
      );
    }
  }

  private resolveProviders(
    method: PaymentMethod,
    kind: 'deposits' | 'payouts',
    preferred?: PaymentProvider | null,
  ): PaymentProvider[] {
    const pawaPayEnabled = this.configService.get<string>(
      kind === 'deposits' ? 'PAWAPAY_DEPOSITS_ENABLED' : 'PAWAPAY_PAYOUTS_ENABLED',
    ) === 'true';
    return resolvePaymentProviders({
      method,
      preferred,
      primary: parsePaymentProvider(
        this.configService.get<string>('PAYMENT_PRIMARY_PROVIDER'),
      ),
      enabled: this.getEnabledProviders().filter((provider) =>
        provider !== PaymentProvider.PAWAPAY || pawaPayEnabled),
      pawaPayConfigured: pawaPayEnabled && (this.pawaPayService?.isConfigured?.() ?? false),
    });
  }

  private getEnabledProviders(): PaymentProvider[] {
    return parseEnabledPaymentProviders(
      this.configService.get<string>('PAYMENT_ENABLED_PROVIDERS'),
    );
  }

  private resetProviderAttempt(
    transaction: PaymentTransaction,
    provider: PaymentProvider,
    kind: 'deposits' | 'payouts',
    domainCallbackUrl?: string,
  ): void {
    transaction.provider = provider;
    transaction.status = PaymentStatus.PENDING;
    transaction.orderNumber = null;
    transaction.providerReference = null;
    transaction.providerStatusCode = null;
    transaction.providerMessage = null;
    transaction.paymentUrl = null;
    transaction.rawInitiationResponse = null;
    transaction.paidAt = null;
    transaction.callbackUrl = this.getProviderCallbackUrl(
      provider,
      kind,
      domainCallbackUrl,
    );
  }

  private async persistFailedInitiation(
    transaction: PaymentTransaction,
    error: unknown,
    keepPending: boolean,
  ): Promise<PaymentTransaction> {
    const errorMessage = this.getErrorMessage(error);
    if (keepPending && transaction.status !== PaymentStatus.FAILED) {
      transaction.status = PaymentStatus.PENDING;
      transaction.providerMessage = this.isPayoutTransaction(transaction)
        ? PAYOUT_MESSAGES.pending
        : 'Confirmation du paiement en attente. Vérifiez son statut avant de réessayer.';
    } else if (transaction.status !== PaymentStatus.FAILED) {
      transaction.status = PaymentStatus.FAILED;
      transaction.providerMessage = this.isPayoutTransaction(transaction)
        ? getPayoutFailureMessage(errorMessage)
        : this.translatePaymentMessage(errorMessage) ?? errorMessage;
    }
    if (transaction.provider === PaymentProvider.PAWAPAY) {
      return commitPawaPayState(this.paymentTransactionRepository, transaction, {
        status: transaction.status, providerMessage: transaction.providerMessage,
      });
    }
    await this.paymentTransactionRepository.save(transaction);
    if (!this.isPayoutTransaction(transaction)) {
      this.logger.error(
        `Payment initiation failed: paymentId=${transaction.id}, reference=${transaction.reference}, method=${transaction.method}, message=${errorMessage}`,
        this.getErrorStack(error),
      );
    }
    return transaction;
  }

  private async initiateFlexPayDeposit(
    savedTransaction: PaymentTransaction,
    input: InitiatePaymentInput,
  ): Promise<PaymentTransaction> {
    const flexPayResponse: FlexPayInitiatePaymentResult =
      await this.flexPayService.initiatePayment({
        method: input.method,
        reference: savedTransaction.reference,
        phone: input.phone,
        amount: input.amount,
        currency: savedTransaction.currency,
        description: input.description,
        callbackUrl:
          savedTransaction.callbackUrl || this.getGenericFlexPayCallbackUrl(),
        approveUrl: input.approveUrl,
        cancelUrl: input.cancelUrl,
        declineUrl: input.declineUrl,
      });

    this.logger.warn(
      `FlexPay initiation received: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, code=${flexPayResponse.code}, orderNumber=${flexPayResponse.orderNumber ?? 'none'}, hasPaymentUrl=${Boolean(flexPayResponse.paymentUrl)}, message=${flexPayResponse.message ?? 'none'}, response=${formatPaymentLogPayload(flexPayResponse.raw)}`,
    );

    savedTransaction.orderNumber = flexPayResponse.orderNumber;
    savedTransaction.providerStatusCode = flexPayResponse.code;
    savedTransaction.paymentUrl = flexPayResponse.paymentUrl;
    savedTransaction.providerMessage = this.getInitiationSuccessMessage(
      savedTransaction.method,
      savedTransaction.paymentUrl,
      flexPayResponse.message,
    );
    savedTransaction.rawInitiationResponse = flexPayResponse.raw;

    if (!this.flexPayService.isSuccessfulCode(flexPayResponse.code)) {
      savedTransaction.status = PaymentStatus.FAILED;
      savedTransaction.providerMessage = this.getInitiationFailureMessage(
        flexPayResponse.message,
      );
      await this.paymentTransactionRepository.save(savedTransaction);
      if (this.looksLikeFlexPayTokenError(flexPayResponse.message)) {
        this.logger.error(
          `FlexPay token configuration rejected: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, code=${flexPayResponse.code}, message=${flexPayResponse.message ?? 'none'}, response=${formatPaymentLogPayload(flexPayResponse.raw)}`,
        );
        if (flexPayResponse.code && !flexPayResponse.orderNumber) {
          throw new PaymentGatewayUnavailableError(PaymentProvider.FLEXPAY,
            'FlexPay a refusé la configuration de paiement', { retryable: true });
        }
      }
      this.logger.warn(
        `Payment refused by FlexPay: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, code=${flexPayResponse.code}, message=${flexPayResponse.message ?? 'none'}, response=${formatPaymentLogPayload(flexPayResponse.raw)}`,
      );
      throw new BadRequestException(savedTransaction.providerMessage);
    }

    savedTransaction.status = PaymentStatus.INITIATED;
    const saved = await this.paymentTransactionRepository.save(savedTransaction);
    this.logger.warn(
      `Payment initialized: paymentId=${saved.id}, reference=${saved.reference}, orderNumber=${saved.orderNumber ?? 'none'}, status=${saved.status}, amount=${saved.amount} ${saved.currency}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(saved))}`,
    );
    return saved;
  }

  private async initiatePawaPayDeposit(
    savedTransaction: PaymentTransaction,
    input: InitiatePaymentInput,
  ): Promise<PaymentTransaction> {
    const depositId = randomUUID();
    savedTransaction.orderNumber = depositId;
    savedTransaction =
      await this.paymentTransactionRepository.save(savedTransaction);

    const result = await this.pawaPayService.initiateDeposit({
      paymentId: depositId,
      phone: input.phone ?? savedTransaction.phone ?? '',
      amount: input.amount,
      currency: savedTransaction.currency,
      description: input.description,
      clientReferenceId: savedTransaction.reference,
      operator: input.pawaPayOperator,
    });

    savedTransaction.rawInitiationResponse = result.raw;
    savedTransaction.providerStatusCode = result.status;
    savedTransaction.paymentUrl = result.paymentUrl;
    if (!result.accepted) {
      savedTransaction.status = PaymentStatus.FAILED;
      savedTransaction.providerMessage =
        result.failureMessage || 'PawaPay a refusé le paiement';
      await commitPawaPayState(this.paymentTransactionRepository, savedTransaction, {
        status: savedTransaction.status, providerMessage: savedTransaction.providerMessage,
        rawInitiationResponse: result.raw, providerStatusCode: result.status,
      });
      throw new BadRequestException(savedTransaction.providerMessage);
    }

    return commitPawaPayState(this.paymentTransactionRepository, savedTransaction, {
      status: PaymentStatus.INITIATED, rawInitiationResponse: result.raw,
      providerStatusCode: result.status, paymentUrl: result.paymentUrl,
      providerMessage: 'Demande de paiement envoyée. Veuillez valider sur votre téléphone',
    });
  }

  private async initiateFlexPayPayout(
    savedTransaction: PaymentTransaction,
    input: InitiatePayoutInput,
  ): Promise<PaymentTransaction> {
    const flexPayResponse = await this.flexPayService.initiatePayout({
      reference: savedTransaction.reference,
      phone: input.phone,
      amount: input.amount,
      currency: savedTransaction.currency,
      description: input.description,
      callbackUrl:
        savedTransaction.callbackUrl || this.getGenericFlexPayCallbackUrl(),
    });
    this.logger.warn(
      `FlexPay payout initiation received: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, code=${flexPayResponse.code}, orderNumber=${flexPayResponse.orderNumber ?? 'none'}, message=${flexPayResponse.message ?? 'none'}, response=${formatPaymentLogPayload(flexPayResponse.raw)}`,
    );

    savedTransaction.orderNumber = flexPayResponse.orderNumber;
    savedTransaction.providerStatusCode =
      flexPayResponse.status ?? flexPayResponse.code;
    savedTransaction.providerMessage =
      flexPayResponse.message || 'Paiement chauffeur initialisé';
    savedTransaction.rawInitiationResponse = flexPayResponse.raw;

    if (flexPayResponse.pending) {
      savedTransaction.status = PaymentStatus.PENDING;
      savedTransaction.providerMessage = PAYOUT_MESSAGES.pending;
      return this.paymentTransactionRepository.save(savedTransaction);
    }

    if (!this.flexPayService.isSuccessfulCode(flexPayResponse.code)) {
      savedTransaction.status = PaymentStatus.FAILED;
      savedTransaction.providerMessage = getPayoutFailureMessage(
        flexPayResponse.message,
      );
      await this.paymentTransactionRepository.save(savedTransaction);
      throw new BadRequestException(savedTransaction.providerMessage);
    }

    savedTransaction.status = PaymentStatus.INITIATED;
    const saved = await this.paymentTransactionRepository.save(savedTransaction);
    this.logger.warn(
      `Payout initialized: paymentId=${saved.id}, reference=${saved.reference}, orderNumber=${saved.orderNumber ?? 'none'}, status=${saved.status}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(saved))}`,
    );
    return saved;
  }

  private async initiatePawaPayPayout(
    savedTransaction: PaymentTransaction,
    input: InitiatePayoutInput,
  ): Promise<PaymentTransaction> {
    const payoutId = randomUUID();
    savedTransaction.orderNumber = payoutId;
    savedTransaction =
      await this.paymentTransactionRepository.save(savedTransaction);

    const result = await this.pawaPayService.initiatePayout({
      paymentId: payoutId,
      phone: input.phone,
      amount: input.amount,
      currency: savedTransaction.currency,
      description: input.description,
      clientReferenceId: savedTransaction.reference,
      operator: input.pawaPayOperator,
    });
    savedTransaction.rawInitiationResponse = result.raw;
    savedTransaction.providerStatusCode = result.status;
    if (!result.accepted) {
      savedTransaction.status = PaymentStatus.FAILED;
      savedTransaction.providerMessage = getPayoutFailureMessage(
        result.failureMessage,
      );
      await commitPawaPayState(this.paymentTransactionRepository, savedTransaction, {
        status: savedTransaction.status, providerMessage: savedTransaction.providerMessage,
        rawInitiationResponse: result.raw, providerStatusCode: result.status,
      });
      throw new BadRequestException(savedTransaction.providerMessage);
    }

    return commitPawaPayState(this.paymentTransactionRepository, savedTransaction, {
      status: PaymentStatus.INITIATED, providerMessage: PAYOUT_MESSAGES.pending,
      rawInitiationResponse: result.raw, providerStatusCode: result.status,
    });
  }

  private async checkPawaPayTransactionAndApply(
    transaction: PaymentTransaction,
  ): Promise<PaymentTransaction> {
    if (!transaction.orderNumber) {
      throw new BadRequestException(
        "L'identifiant de paiement PawaPay est requis",
      );
    }

    const snapshot = this.isPayoutTransaction(transaction)
      ? await this.pawaPayService.checkPayout(transaction.orderNumber)
      : await this.pawaPayService.checkDeposit(transaction.orderNumber);
    // NOT_FOUND is not proof of failure, especially immediately after a POST.
    if (snapshot.status === 'NOT_FOUND') {
      return commitPawaPayState(this.paymentTransactionRepository, transaction, {
        status: PaymentStatus.INITIATED,
        providerStatusCode: 'NOT_FOUND',
        rawCheckResponse: snapshot.raw,
      });
    }
    return this.applyPawaPaySnapshot(transaction, snapshot);
  }

  private async applyPawaPaySnapshot(
    transaction: PaymentTransaction,
    snapshot: PawaPayPaymentSnapshot,
  ): Promise<PaymentTransaction> {
    assertPawaPaySnapshotMatches(transaction, snapshot);
    const completed = this.pawaPayService.isCompleted(snapshot.status);
    const failed = this.pawaPayService.isFailed(snapshot.status);
    return commitPawaPayState(this.paymentTransactionRepository, transaction, {
      status: completed ? PaymentStatus.SUCCEEDED : failed ? PaymentStatus.FAILED : PaymentStatus.INITIATED,
      rawCheckResponse: snapshot.raw, providerStatusCode: snapshot.status,
      providerReference: snapshot.providerTransactionId ?? transaction.providerReference,
      paymentUrl: snapshot.paymentUrl ?? transaction.paymentUrl,
      paidAt: completed ? transaction.paidAt ?? new Date() : transaction.paidAt,
      providerMessage: completed
        ? (this.isPayoutTransaction(transaction) ? 'Zwanga a versé vos gains sur votre compte Mobile Money.' : 'Paiement confirmé avec succès')
        : failed ? (this.isPayoutTransaction(transaction) ? getPayoutFailureMessage(snapshot.failureMessage) : 'Le paiement a échoué. Vous pouvez choisir un autre moyen de paiement.')
        : 'Confirmation du paiement en attente',
    });
  }

  private getProviderCallbackUrl(
    provider: PaymentProvider,
    kind: 'deposits' | 'payouts',
    domainCallbackUrl?: string,
  ): string {
    if (provider === PaymentProvider.PAWAPAY) {
      return this.getPawaPayCallbackUrl(kind);
    }
    return domainCallbackUrl?.trim() || this.getGenericFlexPayCallbackUrl();
  }

  private getPawaPayCallbackUrl(kind: PawaPayCallbackKind): string {
    const explicit = this.configService
      .get<string>(
        kind === 'deposits'
          ? 'PAWAPAY_DEPOSIT_CALLBACK_URL'
          : kind === 'payouts'
            ? 'PAWAPAY_PAYOUT_CALLBACK_URL'
            : 'PAWAPAY_REFUND_CALLBACK_URL',
      )
      ?.trim();
    if (explicit) {
      return explicit;
    }

    return this.joinUrl(
      this.getPublicApiBaseUrl(),
      `payments/pawapay/${kind}/callback`,
    );
  }

  private getCustomerReturnUrl(status: 'success' | 'failed'): string {
    const explicit = this.configService
      .get<string>(
        status === 'success'
          ? 'PAWAPAY_SUCCESS_URL'
          : 'PAWAPAY_FAILED_URL',
      )
      ?.trim();
    if (explicit) {
      return explicit;
    }

    const frontend =
      this.configService.get<string>('FRONTEND_URL')?.trim() ||
      this.configService.get<string>('PUBLIC_APP_URL')?.trim() ||
      'https://zwanga-app.com';
    return this.joinUrl(frontend, `payments/return/${status}`);
  }

  private getPublicApiBaseUrl(): string {
    return (
      this.configService.get<string>('PAWAPAY_CALLBACK_BASE_URL')?.trim() ||
      this.configService.get<string>('FLEXPAY_CALLBACK_BASE_URL')?.trim() ||
      this.configService.get<string>('PUBLIC_API_BASE_URL')?.trim() ||
      this.buildLocalApiBaseUrl()
    );
  }

  private buildLocalApiBaseUrl(): string {
    const port = this.configService.get<string | number>('PORT') || 5200;
    const configuredHost =
      this.configService.get<string>('HOST')?.trim() || 'localhost';
    const host = configuredHost === '0.0.0.0' ? 'localhost' : configuredHost;
    const apiPrefix =
      this.configService.get<string>('API_PREFIX')?.trim() || 'api/v1';
    return `http://${host}:${port}/${apiPrefix}`.replace(/([^:]\/)\/+/g, '$1');
  }

  private generatePaymentReference(
    referencePrefix = 'PAY',
    userId?: string | null,
  ): string {
    const timePart = Date.now().toString(36).toUpperCase();
    const userPart =
      userId
        ?.replace(/[^a-zA-Z0-9]/g, '')
        .toUpperCase()
        .substring(0, 4) || 'GEN';
    const randomPart = randomBytes(3).toString('hex').toUpperCase();
    const base = `${timePart}${userPart}${randomPart}`;
    const maxPrefixLength = Math.max(
      1,
      this.MAX_FLEXPAY_REFERENCE_LENGTH - base.length,
    );
    const safePrefix =
      referencePrefix
        .replace(/[^a-zA-Z0-9]/g, '')
        .toUpperCase()
        .slice(0, maxPrefixLength) || 'PAY';

    return `${safePrefix}${base}`;
  }

  private getGenericFlexPayCallbackUrl(): string {
    const explicitUrl = this.configService
      .get<string>('FLEXPAY_CALLBACK_URL')
      ?.trim();
    if (explicitUrl) {
      return explicitUrl;
    }

    const configuredBaseUrl =
      this.configService.get<string>('FLEXPAY_CALLBACK_BASE_URL')?.trim() ||
      this.configService.get<string>('PUBLIC_API_BASE_URL')?.trim();

    if (configuredBaseUrl) {
      return this.joinUrl(configuredBaseUrl, 'payments/flexpay/callback');
    }

    const port = this.configService.get<string | number>('PORT') || 5200;
    const configuredHost =
      this.configService.get<string>('HOST')?.trim() || 'localhost';
    const host = configuredHost === '0.0.0.0' ? 'localhost' : configuredHost;
    const apiPrefix =
      this.configService.get<string>('API_PREFIX')?.trim() || 'api/v1';

    return this.joinUrl(
      `http://${host}:${port}`,
      apiPrefix,
      'payments/flexpay/callback',
    );
  }

  private shouldVerifyFlexPayCallbacks(): boolean {
    const value = this.configService.get<string>('FLEXPAY_VERIFY_CALLBACKS');
    // Les callbacks transportent un statut, pas une preuve cryptographique.
    // La verification cote FlexPay est donc active par defaut et ne peut etre
    // desactivee que volontairement (tests/sandbox controles).
    return value?.trim().toLowerCase() !== 'false';
  }

  private joinUrl(...parts: string[]): string {
    return parts
      .map((part, index) =>
        index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, ''),
      )
      .filter(Boolean)
      .join('/');
  }

  private getStringValue(
    data: Record<string, unknown>,
    ...keys: string[]
  ): string | null {
    for (const key of keys) {
      const value = data[key];
      if (value !== undefined && value !== null) {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          return String(value);
        }

        return null;
      }
    }

    return null;
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private getErrorStack(error: unknown): string | undefined {
    return error instanceof Error ? error.stack : undefined;
  }

  private getInitiationSuccessMessage(
    method: PaymentMethod,
    paymentUrl: string | null,
    rawMessage?: string | null,
  ): string {
    if (paymentUrl) {
      return 'Redirection vers la page de paiement en cours';
    }

    if (method === PaymentMethod.MOBILE_MONEY) {
      return 'Demande de paiement envoyée. Veuillez valider sur votre téléphone';
    }

    return (
      this.translatePaymentMessage(rawMessage) ??
      'Paiement initialisé avec succès'
    );
  }

  private getInitiationFailureMessage(rawMessage?: string | null): string {
    if (this.looksLikeFlexPayTokenError(rawMessage)) {
      return 'Le service de paiement est momentanément indisponible';
    }

    return (
      this.translatePaymentMessage(rawMessage) ??
      'La demande de paiement a été refusée'
    );
  }

  private getCheckFailureMessage(rawMessage?: string | null): string {
    return (
      this.translatePaymentMessage(rawMessage) ??
      'Vérification du paiement impossible pour le moment'
    );
  }

  private getCallbackFailureMessage(rawMessage?: string | null): string {
    const translatedMessage = this.translatePaymentMessage(rawMessage);
    if (translatedMessage) {
      return translatedMessage;
    }

    return 'Le paiement a été annulé ou a échoué. Aucun montant confirmé.';
  }

  private getMissingTransactionMessage(rawMessage?: string | null): string {
    return (
      this.translatePaymentMessage(rawMessage) ??
      "Aucune transaction de paiement n'a été trouvée"
    );
  }

  private getPendingPaymentMessage(rawMessage?: string | null): string {
    return (
      this.translatePaymentMessage(rawMessage) ??
      'Paiement en attente de confirmation'
    );
  }

  private isTerminalPaymentStatus(status: PaymentStatus): boolean {
    return (
      status === PaymentStatus.SUCCEEDED ||
      status === PaymentStatus.FAILED ||
      status === PaymentStatus.CANCELLED
    );
  }

  private isCancellationMessage(message: string | null | undefined): boolean {
    const normalizedMessage = this.normalizeMessage(message ?? '');
    return (
      normalizedMessage.includes('annule') ||
      normalizedMessage.includes('cancel') ||
      normalizedMessage.includes('cancelled') ||
      normalizedMessage.includes('canceled')
    );
  }

  private isDeclinedPaymentMessage(
    message: string | null | undefined,
  ): boolean {
    const normalizedMessage = this.normalizeMessage(message ?? '');
    return (
      normalizedMessage.includes('declined') ||
      normalizedMessage.includes('refuse') ||
      normalizedMessage.includes('rejet') ||
      normalizedMessage.includes('rejete')
    );
  }

  private maskPaymentPhone(phone: string | null | undefined): string | null {
    if (!phone) {
      return null;
    }

    const digits = phone.replace(/\D/g, '');
    if (digits.length <= 6) {
      return '***';
    }

    return `${digits.slice(0, 3)}***${digits.slice(-4)}`;
  }

  private translatePaymentMessage(
    message: string | null | undefined,
  ): string | null {
    const trimmedMessage = message?.trim();
    if (!trimmedMessage) {
      return null;
    }

    const normalizedMessage = this.normalizeMessage(trimmedMessage);

    if (
      normalizedMessage.includes('transaction envoyee avec succes') &&
      normalizedMessage.includes('push')
    ) {
      return 'Demande de paiement envoyée. Veuillez valider sur votre téléphone';
    }

    if (normalizedMessage.includes('transaction envoyee avec succes')) {
      return 'Demande de paiement envoyée avec succès';
    }

    if (
      normalizedMessage.includes('redirection en cours') ||
      normalizedMessage.includes('redirect')
    ) {
      return 'Redirection vers la page de paiement en cours';
    }

    if (
      normalizedMessage.includes('aucune transaction trouvee') ||
      normalizedMessage.includes('no transaction found')
    ) {
      return "Aucune transaction de paiement n'a été trouvée";
    }

    if (
      normalizedMessage.includes('une transaction trouvee') ||
      normalizedMessage.includes('transaction found')
    ) {
      return 'Paiement en attente de confirmation';
    }

    if (
      normalizedMessage.includes('declined by the operator') ||
      normalizedMessage.includes('declined') ||
      normalizedMessage.includes('refuse par l operateur') ||
      normalizedMessage.includes('rejetee par l operateur') ||
      normalizedMessage.includes('rejete par l operateur')
    ) {
      return 'Paiement refusé par l’opérateur. Aucun montant confirmé.';
    }

    if (
      normalizedMessage.includes('solde insuffisant') ||
      normalizedMessage.includes('insufficient') ||
      normalizedMessage.includes('insufisant') ||
      normalizedMessage.includes('insuffisant')
    ) {
      return 'Paiement échoué : solde insuffisant.';
    }

    if (
      normalizedMessage.includes('annule') ||
      normalizedMessage.includes('cancel') ||
      normalizedMessage.includes('cancelled') ||
      normalizedMessage.includes('canceled')
    ) {
      return 'Paiement annulé. Aucun montant confirmé.';
    }

    if (
      normalizedMessage.includes('paiement flexpay non abouti') ||
      normalizedMessage.includes('paiement flexpay echoue') ||
      normalizedMessage.includes('payment failed') ||
      normalizedMessage.includes('transaction failed')
    ) {
      return 'Le paiement a échoué';
    }

    if (
      normalizedMessage.includes('paiement flexpay confirme') ||
      normalizedMessage.includes('payment confirmed')
    ) {
      return 'Paiement confirmé avec succès';
    }

    if (
      normalizedMessage.includes(
        'callback recu verification flexpay en attente',
      )
    ) {
      return 'Notification de paiement reçue. Vérification du paiement en cours';
    }

    if (
      normalizedMessage.includes('callback flexpay recu sans ordernumber') ||
      normalizedMessage.includes('numero de commande flexpay est manquant')
    ) {
      return 'Notification de paiement reçue, mais le numéro de commande FlexPay est manquant';
    }

    if (
      normalizedMessage.includes('flexpay a refuse la requete de paiement') ||
      normalizedMessage.includes('payment refused') ||
      normalizedMessage.includes('request refused')
    ) {
      return 'La demande de paiement a été refusée';
    }

    return trimmedMessage;
  }

  private normalizeMessage(message: string): string {
    return message
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  private looksLikeFlexPayTokenError(
    message: string | null | undefined,
  ): boolean {
    const normalizedMessage = (message ?? '').toLowerCase();
    return normalizedMessage.includes('token');
  }
}
