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

export interface NormalizedFlexPayCallback {
  code: string;
  reference: string;
  providerReference: string | null;
  orderNumber: string | null;
  raw: Record<string, unknown>;
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
      savedTransaction.providerMessage = errorMessage;
      await this.paymentTransactionRepository.save(savedTransaction);
      this.logger.error(
        `Payment initiation failed: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, method=${savedTransaction.method}, message=${errorMessage}`,
        this.getErrorStack(error),
      );
      throw error;
    }

    this.logger.log(
      `FlexPay initiation received: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, code=${flexPayResponse.code}, orderNumber=${flexPayResponse.orderNumber ?? 'none'}, hasPaymentUrl=${Boolean(flexPayResponse.paymentUrl)}, message=${flexPayResponse.message ?? 'none'}`,
    );

    savedTransaction.orderNumber = flexPayResponse.orderNumber;
    savedTransaction.providerStatusCode = flexPayResponse.code;
    savedTransaction.providerMessage = flexPayResponse.message;
    savedTransaction.paymentUrl = flexPayResponse.paymentUrl;
    savedTransaction.rawInitiationResponse = flexPayResponse.raw;

    if (!this.flexPayService.isSuccessfulCode(flexPayResponse.code)) {
      savedTransaction.status = PaymentStatus.FAILED;
      await this.paymentTransactionRepository.save(savedTransaction);
      if (this.looksLikeFlexPayTokenError(flexPayResponse.message)) {
        this.logger.error(
          `FlexPay token configuration rejected: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, code=${flexPayResponse.code}, message=${flexPayResponse.message ?? 'none'}`,
        );
      }
      this.logger.warn(
        `Payment refused by FlexPay: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, code=${flexPayResponse.code}, message=${flexPayResponse.message ?? 'none'}`,
      );
      throw new BadRequestException(
        flexPayResponse.message || 'FlexPay a refuse la requete de paiement',
      );
    }

    savedTransaction.status = PaymentStatus.INITIATED;
    savedTransaction =
      await this.paymentTransactionRepository.save(savedTransaction);

    this.logger.log(
      `Payment initialized: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, orderNumber=${savedTransaction.orderNumber ?? 'none'}, status=${savedTransaction.status}, amount=${savedTransaction.amount} ${savedTransaction.currency}`,
    );

    return savedTransaction;
  }

  async handleFlexPayCallback(
    dto: FlexPayCallbackDto,
  ): Promise<PaymentTransaction> {
    const callback = this.normalizeFlexPayCallback(dto);
    this.logger.log(
      `FlexPay callback received: reference=${callback.reference}, orderNumber=${callback.orderNumber ?? 'none'}, code=${callback.code}, providerReference=${callback.providerReference ?? 'none'}`,
    );

    const transaction = await this.findTransactionByReferenceOrOrderNumber(
      callback.reference,
      callback.orderNumber ?? undefined,
    );
    const previousStatus = transaction.status;

    this.logger.log(
      `FlexPay callback matched payment: paymentId=${transaction.id}, reference=${transaction.reference}, previousStatus=${previousStatus}, orderNumber=${transaction.orderNumber ?? 'none'}`,
    );

    transaction.providerStatusCode = callback.code;
    transaction.providerReference =
      callback.providerReference ?? transaction.providerReference;
    transaction.orderNumber = callback.orderNumber ?? transaction.orderNumber;
    transaction.rawCallbackPayload = callback.raw;

    if (!this.flexPayService.isSuccessfulCode(callback.code)) {
      transaction.status = PaymentStatus.FAILED;
      transaction.providerMessage = 'Paiement FlexPay non abouti';
      const savedTransaction =
        await this.paymentTransactionRepository.save(transaction);
      this.logger.warn(
        `Payment marked failed from FlexPay callback: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, previousStatus=${previousStatus}, code=${callback.code}`,
      );
      return savedTransaction;
    }

    if (this.shouldVerifyFlexPayCallbacks()) {
      if (!transaction.orderNumber) {
        transaction.providerMessage = 'Callback FlexPay recu sans orderNumber';
        const savedTransaction =
          await this.paymentTransactionRepository.save(transaction);
        this.logger.warn(
          `FlexPay callback cannot be verified without orderNumber: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}`,
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
          'Callback recu, verification FlexPay en attente';
        return this.paymentTransactionRepository.save(transaction);
      }
    }

    transaction.status = PaymentStatus.SUCCEEDED;
    transaction.providerMessage = 'Paiement FlexPay confirme';
    transaction.paidAt = transaction.paidAt ?? new Date();
    const savedTransaction =
      await this.paymentTransactionRepository.save(transaction);
    this.logger.log(
      `Payment confirmed from FlexPay callback: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, previousStatus=${previousStatus}, status=${savedTransaction.status}`,
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

    return this.checkTransactionAndApply(transaction);
  }

  isSuccessfulPayment(transaction: PaymentTransaction): boolean {
    return transaction.status === PaymentStatus.SUCCEEDED;
  }

  normalizeFlexPayCallback(dto: FlexPayCallbackDto): NormalizedFlexPayCallback {
    const raw = dto as Record<string, unknown>;
    const code = this.getStringValue(raw, 'code', 'Code');
    const reference = this.getStringValue(raw, 'reference', 'Reference');
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

    return this.applyFlexPayCheckResult(transaction, checkResult);
  }

  private async applyFlexPayCheckResult(
    transaction: PaymentTransaction,
    checkResult: FlexPayCheckTransactionResult,
  ): Promise<PaymentTransaction> {
    const previousStatus = transaction.status;
    transaction.providerStatusCode =
      checkResult.transaction?.status ?? checkResult.code;
    transaction.providerMessage = checkResult.message;
    transaction.rawCheckResponse = checkResult.raw;

    if (!this.flexPayService.isSuccessfulCode(checkResult.code)) {
      const savedTransaction =
        await this.paymentTransactionRepository.save(transaction);
      this.logger.warn(
        `FlexPay check returned non-success code: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, code=${checkResult.code}, message=${checkResult.message ?? 'none'}, status=${savedTransaction.status}`,
      );
      return savedTransaction;
    }

    const providerTransaction = checkResult.transaction;
    if (!providerTransaction) {
      transaction.providerMessage =
        checkResult.message || 'Transaction FlexPay introuvable';
      const savedTransaction =
        await this.paymentTransactionRepository.save(transaction);
      this.logger.warn(
        `FlexPay check returned no transaction: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, orderNumber=${savedTransaction.orderNumber ?? 'none'}`,
      );
      return savedTransaction;
    }

    if (
      providerTransaction.reference &&
      providerTransaction.reference !== transaction.reference
    ) {
      this.logger.warn(
        `FlexPay check reference mismatch: paymentId=${transaction.id}, expectedReference=${transaction.reference}, providerReference=${providerTransaction.reference}, orderNumber=${providerTransaction.orderNumber ?? transaction.orderNumber ?? 'none'}`,
      );
      throw new BadRequestException(
        'La reference FlexPay ne correspond pas a cette transaction',
      );
    }

    transaction.orderNumber =
      providerTransaction.orderNumber ?? transaction.orderNumber;

    if (this.flexPayService.isSuccessfulTransaction(providerTransaction)) {
      transaction.status = PaymentStatus.SUCCEEDED;
      transaction.providerMessage =
        checkResult.message || 'Paiement FlexPay confirme';
      transaction.paidAt = transaction.paidAt ?? new Date();
      const savedTransaction =
        await this.paymentTransactionRepository.save(transaction);
      this.logger.log(
        `Payment confirmed from FlexPay check: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, previousStatus=${previousStatus}, status=${savedTransaction.status}, providerStatus=${providerTransaction.status}`,
      );
      return savedTransaction;
    }

    if (providerTransaction.status === '1') {
      transaction.status = PaymentStatus.FAILED;
      transaction.providerMessage =
        checkResult.message || 'Paiement FlexPay echoue';
    }

    const savedTransaction =
      await this.paymentTransactionRepository.save(transaction);
    this.logger.log(
      `Payment updated from FlexPay check: paymentId=${savedTransaction.id}, reference=${savedTransaction.reference}, previousStatus=${previousStatus}, status=${savedTransaction.status}, providerStatus=${providerTransaction.status ?? 'none'}`,
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
    return value?.toLowerCase() !== 'false';
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
        return String(value);
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

  private looksLikeFlexPayTokenError(
    message: string | null | undefined,
  ): boolean {
    const normalizedMessage = (message ?? '').toLowerCase();
    return normalizedMessage.includes('token');
  }
}
