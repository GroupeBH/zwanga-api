import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';
import { FlexPayCallbackDto } from './dto/payment.dto';
import {
  FlexPayCheckTransactionResult,
  FlexPayInitiatePaymentResult,
  FlexPayService,
} from './flexpay.service';
import { formatPaymentLogPayload } from './payment-log.util';

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
  ) {}

  async initiatePayment(
    input: InitiatePaymentInput,
  ): Promise<PaymentTransaction> {
    this.ensurePaymentInputIsUsable(input);
    const callbackUrl =
      input.callbackUrl || this.getGenericFlexPayCallbackUrl();

    const transaction = this.paymentTransactionRepository.create({
      userId: input.userId ?? null,
      purpose: input.purpose || PaymentPurpose.GENERIC,
      relatedEntityType: input.relatedEntityType ?? null,
      relatedEntityId: input.relatedEntityId ?? null,
      provider: PaymentProvider.FLEXPAY,
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
      callbackUrl,
      rawInitiationResponse: null,
      rawCallbackPayload: null,
      rawCheckResponse: null,
      paidAt: null,
    });

    let savedTransaction =
      await this.paymentTransactionRepository.save(transaction);
    let flexPayResponse: FlexPayInitiatePaymentResult;

    this.logger.log(
      `Payment transaction created: id=${savedTransaction.id}, reference=${savedTransaction.reference}, userId=${savedTransaction.userId ?? 'anonymous'}, purpose=${savedTransaction.purpose}, method=${savedTransaction.method}, amount=${savedTransaction.amount} ${savedTransaction.currency}, related=${savedTransaction.relatedEntityType ?? 'none'}:${savedTransaction.relatedEntityId ?? 'none'}`,
    );
    this.logger.log(
      `Starting FlexPay initiation: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, method=${savedTransaction.method}`,
    );

    try {
      flexPayResponse = await this.flexPayService.initiatePayment({
        method: input.method,
        reference: savedTransaction.reference,
        phone: input.phone,
        amount: input.amount,
        currency: savedTransaction.currency,
        description: input.description,
        callbackUrl,
        approveUrl: input.approveUrl,
        cancelUrl: input.cancelUrl,
        declineUrl: input.declineUrl,
      });
    } catch (error) {
      const errorMessage = this.getErrorMessage(error);
      savedTransaction.status = PaymentStatus.FAILED;
      savedTransaction.providerMessage =
        this.translatePaymentMessage(errorMessage) ?? errorMessage;
      await this.paymentTransactionRepository.save(savedTransaction);
      this.logger.error(
        `Payment initiation failed: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, method=${savedTransaction.method}, message=${errorMessage}`,
        this.getErrorStack(error),
      );
      throw error;
    }

    this.logger.log(
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
      }
      this.logger.warn(
        `Payment refused by FlexPay: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, code=${flexPayResponse.code}, message=${flexPayResponse.message ?? 'none'}, response=${formatPaymentLogPayload(flexPayResponse.raw)}`,
      );
      throw new BadRequestException(savedTransaction.providerMessage);
    }

    savedTransaction.status = PaymentStatus.INITIATED;
    savedTransaction =
      await this.paymentTransactionRepository.save(savedTransaction);

    this.logger.log(
      `Payment initialized: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, orderNumber=${savedTransaction.orderNumber ?? 'none'}, status=${savedTransaction.status}, amount=${savedTransaction.amount} ${savedTransaction.currency}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(savedTransaction))}`,
    );

    return savedTransaction;
  }

  async initiatePayout(
    input: InitiatePayoutInput,
  ): Promise<PaymentTransaction> {
    this.ensurePayoutInputIsUsable(input);
    const callbackUrl =
      input.callbackUrl || this.getGenericFlexPayCallbackUrl();

    const transaction = this.paymentTransactionRepository.create({
      userId: input.userId,
      purpose: input.purpose || PaymentPurpose.DRIVER_PAYOUT,
      relatedEntityType: input.relatedEntityType ?? null,
      relatedEntityId: input.relatedEntityId ?? null,
      provider: PaymentProvider.FLEXPAY,
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
      callbackUrl,
      rawInitiationResponse: null,
      rawCallbackPayload: null,
      rawCheckResponse: null,
      paidAt: null,
    });

    let savedTransaction =
      await this.paymentTransactionRepository.save(transaction);

    this.logger.log(
      `Payout transaction created: id=${savedTransaction.id}, reference=${savedTransaction.reference}, userId=${savedTransaction.userId}, amount=${savedTransaction.amount} ${savedTransaction.currency}, related=${savedTransaction.relatedEntityType ?? 'none'}:${savedTransaction.relatedEntityId ?? 'none'}`,
    );

    try {
      const flexPayResponse = await this.flexPayService.initiatePayout({
        reference: savedTransaction.reference,
        phone: input.phone,
        amount: input.amount,
        currency: savedTransaction.currency,
        callbackUrl,
      });
      this.logger.log(
        `FlexPay payout initiation received: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, code=${flexPayResponse.code}, orderNumber=${flexPayResponse.orderNumber ?? 'none'}, message=${flexPayResponse.message ?? 'none'}, response=${formatPaymentLogPayload(flexPayResponse.raw)}`,
      );

      savedTransaction.orderNumber = flexPayResponse.orderNumber;
      savedTransaction.providerStatusCode = flexPayResponse.code;
      savedTransaction.providerMessage =
        flexPayResponse.message || 'Paiement chauffeur initialise';
      savedTransaction.rawInitiationResponse = flexPayResponse.raw;

      if (!this.flexPayService.isSuccessfulCode(flexPayResponse.code)) {
        savedTransaction.status = PaymentStatus.FAILED;
        savedTransaction.providerMessage = this.getInitiationFailureMessage(
          flexPayResponse.message,
        );
        await this.paymentTransactionRepository.save(savedTransaction);
        throw new BadRequestException(savedTransaction.providerMessage);
      }

      savedTransaction.status = PaymentStatus.INITIATED;
      savedTransaction =
        await this.paymentTransactionRepository.save(savedTransaction);
      this.logger.log(
        `Payout initialized: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, orderNumber=${savedTransaction.orderNumber ?? 'none'}, status=${savedTransaction.status}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(savedTransaction))}`,
      );
      return savedTransaction;
    } catch (error) {
      const errorMessage = this.getErrorMessage(error);
      savedTransaction.status = PaymentStatus.FAILED;
      savedTransaction.providerMessage =
        this.translatePaymentMessage(errorMessage) ?? errorMessage;
      await this.paymentTransactionRepository.save(savedTransaction);
      this.logger.error(
        `Payout initiation failed: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, message=${errorMessage}`,
        this.getErrorStack(error),
      );
      throw error;
    }
  }

  async handleFlexPayCallback(
    dto: FlexPayCallbackDto,
  ): Promise<PaymentTransaction> {
    const callback = this.normalizeFlexPayCallback(dto);
    this.logger.log(
      `FlexPay callback received: reference=${callback.reference}, orderNumber=${callback.orderNumber ?? 'none'}, code=${callback.code}, providerReference=${callback.providerReference ?? 'none'}, payload=${formatPaymentLogPayload(callback.raw)}`,
    );

    const transaction = await this.findTransactionByReferenceOrOrderNumber(
      callback.reference,
      callback.orderNumber ?? undefined,
    );
    const previousStatus = transaction.status;
    const callbackSucceeded = this.flexPayService.isSuccessfulCode(
      callback.code,
    );

    this.logger.log(
      `FlexPay callback matched payment: paymentId=${transaction.id}, reference=${transaction.reference}, previousStatus=${previousStatus}, orderNumber=${transaction.orderNumber ?? 'none'}`,
    );

    if (!callbackSucceeded && previousStatus === PaymentStatus.SUCCEEDED) {
      this.logger.warn(
        `Ignoring non-success FlexPay callback for already succeeded payment: paymentId=${transaction.id}, reference=${transaction.reference}, code=${callback.code}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(transaction))}`,
      );
      return transaction;
    }

    transaction.providerStatusCode = callback.code;
    transaction.providerReference =
      callback.providerReference ?? transaction.providerReference;
    transaction.orderNumber = callback.orderNumber ?? transaction.orderNumber;
    transaction.rawCallbackPayload = callback.raw;

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

    if (this.shouldVerifyFlexPayCallbacks()) {
      if (!transaction.orderNumber) {
        transaction.providerMessage =
          'Notification de paiement recue, mais le numero de commande FlexPay est manquant';
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
          'Notification de paiement recue. Verification du paiement en cours';
        const savedTransaction =
          await this.paymentTransactionRepository.save(transaction);
        this.logger.warn(
          `FlexPay callback verification pending response: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(savedTransaction))}`,
        );
        return savedTransaction;
      }
    }

    transaction.status = PaymentStatus.SUCCEEDED;
    transaction.providerMessage = 'Paiement confirme avec succes';
    transaction.paidAt = transaction.paidAt ?? new Date();
    const savedTransaction =
      await this.paymentTransactionRepository.save(transaction);
    this.logger.log(
      `Payment confirmed from FlexPay callback: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, previousStatus=${previousStatus}, status=${savedTransaction.status}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(savedTransaction))}`,
    );
    return savedTransaction;
  }

  async checkPaymentStatus(
    orderNumber: string,
    userId?: string,
  ): Promise<PaymentTransaction> {
    this.logger.log(
      `Payment status check requested: orderNumber=${orderNumber}, userId=${userId ?? 'none'}`,
    );
    const transaction = await this.findTransactionByOrderNumber(
      orderNumber,
      userId,
    );
    this.logger.log(
      `Payment status check matched payment: paymentId=${transaction.id}, reference=${transaction.reference}, currentStatus=${transaction.status}`,
    );

    if (this.isTerminalPaymentStatus(transaction.status)) {
      this.logger.log(
        `Payment status check served from local terminal state: paymentId=${transaction.id}, status=${transaction.status}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(transaction))}`,
      );
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
    transaction: Pick<
      PaymentTransaction,
      'status' | 'method' | 'paymentUrl' | 'providerMessage'
    > | null,
  ): string | null {
    if (!transaction) {
      return null;
    }

    const translatedProviderMessage = this.translatePaymentMessage(
      transaction.providerMessage,
    );
    if (translatedProviderMessage) {
      return translatedProviderMessage;
    }

    switch (transaction.status) {
      case PaymentStatus.SUCCEEDED:
        return 'Paiement confirme avec succes';
      case PaymentStatus.FAILED:
        return 'Le paiement a echoue';
      case PaymentStatus.CANCELLED:
        return 'Le paiement a ete annule';
      case PaymentStatus.INITIATED:
        if (transaction.paymentUrl) {
          return 'Redirection vers la page de paiement en cours';
        }
        if (transaction.method === PaymentMethod.MOBILE_MONEY) {
          return 'Demande de paiement envoyee. Veuillez valider sur votre telephone';
        }
        return 'Paiement initialise. Verification en cours';
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
        'Le callback FlexPay doit contenir code et reference',
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
    if (!transaction.orderNumber) {
      throw new BadRequestException('Le numero de commande FlexPay est requis');
    }

    this.logger.log(
      `Checking FlexPay transaction: paymentId=${transaction.id}, reference=${transaction.reference}, orderNumber=${transaction.orderNumber}, currentStatus=${transaction.status}`,
    );

    const checkResult = await this.flexPayService.checkTransaction(
      transaction.orderNumber,
    );
    this.logger.log(
      `FlexPay check result received: paymentId=${transaction.id}, reference=${transaction.reference}, orderNumber=${transaction.orderNumber}, response=${formatPaymentLogPayload(checkResult.raw)}`,
    );

    return this.applyFlexPayCheckResult(transaction, checkResult);
  }

  private async applyFlexPayCheckResult(
    transaction: PaymentTransaction,
    checkResult: FlexPayCheckTransactionResult,
  ): Promise<PaymentTransaction> {
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
          'La reference FlexPay ne correspond pas a cette transaction',
        );
      }
    }

    const providerTransactionStatus =
      providerTransaction.status ?? providerTransaction.code;

    transaction.orderNumber =
      providerTransaction.orderNumber ?? transaction.orderNumber;

    if (this.flexPayService.isSuccessfulTransaction(providerTransaction)) {
      transaction.status = PaymentStatus.SUCCEEDED;
      transaction.providerMessage = 'Paiement confirme avec succes';
      transaction.paidAt = transaction.paidAt ?? new Date();
      const savedTransaction =
        await this.paymentTransactionRepository.save(transaction);
      this.logger.log(
        `Payment confirmed from FlexPay check: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, previousStatus=${previousStatus}, status=${savedTransaction.status}, providerStatus=${providerTransactionStatus}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(savedTransaction))}`,
      );
      return savedTransaction;
    }

    if (
      providerTransactionStatus === '1' ||
      this.isDeclinedPaymentMessage(checkResult.message)
    ) {
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
    this.logger.log(
      `Payment updated from FlexPay check: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, previousStatus=${previousStatus}, status=${savedTransaction.status}, providerStatus=${providerTransactionStatus ?? 'none'}, response=${formatPaymentLogPayload(this.formatPaymentLogResponse(savedTransaction))}`,
    );
    return savedTransaction;
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
        'Le numero de telephone est requis pour payer par Mobile Money',
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
        'Le numero de telephone est requis pour le paiement chauffeur',
      );
    }

    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new BadRequestException('Le montant du paiement est invalide');
    }

    if (!input.currency?.trim()) {
      throw new BadRequestException('La devise du paiement est requise');
    }
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
    return value?.toLowerCase() === 'true';
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
      return 'Demande de paiement envoyee. Veuillez valider sur votre telephone';
    }

    return (
      this.translatePaymentMessage(rawMessage) ??
      'Paiement initialise avec succes'
    );
  }

  private getInitiationFailureMessage(rawMessage?: string | null): string {
    if (this.looksLikeFlexPayTokenError(rawMessage)) {
      return 'Le service de paiement est momentanement indisponible';
    }

    return (
      this.translatePaymentMessage(rawMessage) ??
      'La demande de paiement a ete refusee'
    );
  }

  private getCheckFailureMessage(rawMessage?: string | null): string {
    return (
      this.translatePaymentMessage(rawMessage) ??
      'Verification du paiement impossible pour le moment'
    );
  }

  private getCallbackFailureMessage(rawMessage?: string | null): string {
    const translatedMessage = this.translatePaymentMessage(rawMessage);
    if (translatedMessage) {
      return translatedMessage;
    }

    return 'Le paiement a ete annule ou a echoue. Aucun montant confirme.';
  }

  private getMissingTransactionMessage(rawMessage?: string | null): string {
    return (
      this.translatePaymentMessage(rawMessage) ??
      "Aucune transaction de paiement n'a ete trouvee"
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

  private isDeclinedPaymentMessage(message: string | null | undefined): boolean {
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
      return 'Demande de paiement envoyee. Veuillez valider sur votre telephone';
    }

    if (normalizedMessage.includes('transaction envoyee avec succes')) {
      return 'Demande de paiement envoyee avec succes';
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
      return "Aucune transaction de paiement n'a ete trouvee";
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
      return 'Paiement refuse par l operateur. Aucun montant confirme.';
    }

    if (
      normalizedMessage.includes('solde insuffisant') ||
      normalizedMessage.includes('insufficient') ||
      normalizedMessage.includes('insufisant') ||
      normalizedMessage.includes('insuffisant')
    ) {
      return 'Paiement echoue: solde insuffisant.';
    }

    if (
      normalizedMessage.includes('annule') ||
      normalizedMessage.includes('cancel') ||
      normalizedMessage.includes('cancelled') ||
      normalizedMessage.includes('canceled')
    ) {
      return 'Paiement annule. Aucun montant confirme.';
    }

    if (
      normalizedMessage.includes('paiement flexpay non abouti') ||
      normalizedMessage.includes('paiement flexpay echoue') ||
      normalizedMessage.includes('payment failed') ||
      normalizedMessage.includes('transaction failed')
    ) {
      return 'Le paiement a echoue';
    }

    if (
      normalizedMessage.includes('paiement flexpay confirme') ||
      normalizedMessage.includes('payment confirmed')
    ) {
      return 'Paiement confirme avec succes';
    }

    if (
      normalizedMessage.includes(
        'callback recu verification flexpay en attente',
      )
    ) {
      return 'Notification de paiement recue. Verification du paiement en cours';
    }

    if (
      normalizedMessage.includes('callback flexpay recu sans ordernumber') ||
      normalizedMessage.includes('numero de commande flexpay est manquant')
    ) {
      return 'Notification de paiement recue, mais le numero de commande FlexPay est manquant';
    }

    if (
      normalizedMessage.includes('flexpay a refuse la requete de paiement') ||
      normalizedMessage.includes('payment refused') ||
      normalizedMessage.includes('request refused')
    ) {
      return 'La demande de paiement a ete refusee';
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
