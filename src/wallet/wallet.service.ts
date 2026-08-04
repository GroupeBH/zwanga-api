import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { FlexPayCallbackDto } from '../payments/dto/payment.dto';
import { PaymentsService } from '../payments/payments.service';
import { Booking } from '../bookings/entities/booking.entity';
import {
  WalletAccount,
  WalletAccountType,
} from './entities/wallet-account.entity';
import {
  WalletLedgerEntry,
  WalletLedgerEntryType,
} from './entities/wallet-ledger-entry.entity';
import { InitiateWalletTopUpDto } from './dto/wallet.dto';

export interface WalletSummary {
  account: WalletAccount;
  recentEntries: WalletLedgerEntry[];
}

export interface WalletPaymentResponse {
  account: WalletAccount;
  payment: {
    transactionId: string | null;
    method: PaymentMethod | null;
    reference: string | null;
    orderNumber: string | null;
    status: PaymentStatus | null;
    statusCode: string | null;
    message: string | null;
    paymentUrl: string | null;
    amount: number;
    currency: string;
  };
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly TOP_UP_RELATED_ENTITY_TYPE = 'wallet_top_up';
  private readonly BOOKING_RELATED_ENTITY_TYPE = 'booking';
  private readonly DEFAULT_POINTS_CURRENCY = 'CDF';
  private readonly DEFAULT_LOYALTY_RATE = 0.01;

  constructor(
    @InjectRepository(WalletAccount)
    private readonly accountRepository: Repository<WalletAccount>,
    @InjectRepository(WalletLedgerEntry)
    private readonly ledgerRepository: Repository<WalletLedgerEntry>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async getSummary(userId: string): Promise<WalletSummary> {
    const account = await this.getOrCreateAccount(userId);
    const recentEntries = await this.ledgerRepository.find({
      where: { userId, accountType: WalletAccountType.POINTS },
      order: { createdAt: 'DESC' },
      take: 30,
    });

    return { account, recentEntries };
  }

  async getLedger(userId: string): Promise<WalletLedgerEntry[]> {
    return this.ledgerRepository.find({
      where: { userId, accountType: WalletAccountType.POINTS },
      order: { createdAt: 'DESC' },
    });
  }

  async initiateTopUp(
    userId: string,
    dto: InitiateWalletTopUpDto,
  ): Promise<WalletPaymentResponse> {
    const amount = this.normalizePositiveAmount(dto.amount);
    const currency = this.getPointsCurrency();

    const payment = await this.paymentsService.initiatePayment({
      userId,
      purpose: PaymentPurpose.WALLET_TOP_UP,
      relatedEntityType: this.TOP_UP_RELATED_ENTITY_TYPE,
      relatedEntityId: userId,
      method: dto.method,
      phone: dto.phone,
      amount,
      currency,
      description: `Achat de ${amount} points Zwanga`,
      callbackUrl: this.getTopUpFlexPayCallbackUrl(),
      approveUrl: dto.approveUrl,
      cancelUrl: dto.cancelUrl,
      declineUrl: dto.declineUrl,
      referencePrefix: 'WAL',
    });

    const account = await this.getOrCreateAccount(userId);
    const response = this.buildPaymentResponse(account, payment);
    this.logWalletPaymentResponse('Wallet topup initialized', response);
    return response;
  }

  async handleTopUpCallback(
    dto: FlexPayCallbackDto,
  ): Promise<WalletPaymentResponse> {
    const payment = await this.paymentsService.handleFlexPayCallback(dto);
    const account = await this.applyTopUpPayment(payment);
    const response = this.buildPaymentResponse(account, payment);
    this.logWalletPaymentResponse('Wallet topup callback applied', response);
    return response;
  }

  async checkTopUpPaymentStatus(
    userId: string,
    orderNumber: string,
  ): Promise<WalletPaymentResponse> {
    const payment = await this.paymentsService.checkPaymentStatus(
      orderNumber,
      userId,
    );
    const account = await this.applyTopUpPayment(payment);
    const response = this.buildPaymentResponse(account, payment);
    this.logWalletPaymentResponse('Wallet topup status check', response);
    return response;
  }

  async payForBooking(booking: Booking, amount: number): Promise<void> {
    const normalizedAmount = this.normalizePositiveAmount(amount);
    if (normalizedAmount <= 0) {
      return;
    }

    const existingEntry = await this.findBookingEntry(
      booking.passengerId,
      booking.id,
      WalletLedgerEntryType.BOOKING_PAYMENT,
    );
    if (existingEntry) {
      return;
    }

    await this.changeBalance({
      userId: booking.passengerId,
      amount: -normalizedAmount,
      type: WalletLedgerEntryType.BOOKING_PAYMENT,
      relatedEntityType: this.BOOKING_RELATED_ENTITY_TYPE,
      relatedEntityId: booking.id,
      description: `Paiement par points pour la reservation ${booking.id}`,
    });
  }

  async refundBookingPayment(booking: Booking): Promise<boolean> {
    const paymentEntry = await this.findBookingEntry(
      booking.passengerId,
      booking.id,
      WalletLedgerEntryType.BOOKING_PAYMENT,
    );
    if (!paymentEntry) {
      return false;
    }

    const refundEntry = await this.findBookingEntry(
      booking.passengerId,
      booking.id,
      WalletLedgerEntryType.BOOKING_REFUND,
    );
    if (refundEntry) {
      return false;
    }

    await this.changeBalance({
      userId: booking.passengerId,
      amount: Math.abs(Number(paymentEntry.amount)),
      type: WalletLedgerEntryType.BOOKING_REFUND,
      relatedEntityType: this.BOOKING_RELATED_ENTITY_TYPE,
      relatedEntityId: booking.id,
      description: `Remboursement points pour la reservation ${booking.id}`,
    });
    return true;
  }

  async creditBookingFareAdjustment(
    booking: Booking,
    amount: number,
  ): Promise<WalletLedgerEntry | null> {
    const normalizedAmount = this.normalizePositiveAmount(amount);
    if (normalizedAmount <= 0) {
      return null;
    }

    const existingEntry = await this.findBookingEntry(
      booking.passengerId,
      booking.id,
      WalletLedgerEntryType.BOOKING_FARE_ADJUSTMENT,
    );
    if (existingEntry) {
      return existingEntry;
    }

    return this.changeBalance({
      userId: booking.passengerId,
      amount: normalizedAmount,
      type: WalletLedgerEntryType.BOOKING_FARE_ADJUSTMENT,
      relatedEntityType: this.BOOKING_RELATED_ENTITY_TYPE,
      relatedEntityId: booking.id,
      paymentTransactionId: booking.paymentTransactionId,
      description: `Ajustement du prix kilometrique pour la reservation ${booking.id}`,
    });
  }

  async awardLoyaltyForBooking(
    booking: Booking,
    grossAmount: number,
  ): Promise<WalletLedgerEntry | null> {
    const reward = this.calculateLoyaltyReward(grossAmount);
    if (reward <= 0) {
      return null;
    }

    const existingEntry = await this.findBookingEntry(
      booking.passengerId,
      booking.id,
      WalletLedgerEntryType.LOYALTY_REWARD,
    );
    if (existingEntry) {
      return existingEntry;
    }

    return this.changeBalance({
      userId: booking.passengerId,
      amount: reward,
      type: WalletLedgerEntryType.LOYALTY_REWARD,
      relatedEntityType: this.BOOKING_RELATED_ENTITY_TYPE,
      relatedEntityId: booking.id,
      description: `Points de fidelite pour la reservation ${booking.id}`,
    });
  }

  async ensureSufficientPoints(userId: string, amount: number): Promise<void> {
    const account = await this.getOrCreateAccount(userId);
    if (Number(account.balance) < amount) {
      throw new BadRequestException(
        'Solde de points insuffisant pour payer ce trajet',
      );
    }
  }

  private async applyTopUpPayment(
    payment: PaymentTransaction,
  ): Promise<WalletAccount> {
    if (
      payment.purpose !== PaymentPurpose.WALLET_TOP_UP ||
      payment.relatedEntityType !== this.TOP_UP_RELATED_ENTITY_TYPE ||
      !payment.userId
    ) {
      throw new BadRequestException(
        'Cette transaction ne correspond pas a une recharge de points',
      );
    }

    if (payment.status !== PaymentStatus.SUCCEEDED) {
      return this.getOrCreateAccount(payment.userId);
    }

    const existingEntry = await this.ledgerRepository.findOne({
      where: {
        paymentTransactionId: payment.id,
        type: WalletLedgerEntryType.TOP_UP,
      },
    });
    if (existingEntry) {
      return this.getOrCreateAccount(payment.userId);
    }

    await this.changeBalance({
      userId: payment.userId,
      amount: this.normalizePositiveAmount(Number(payment.amount)),
      type: WalletLedgerEntryType.TOP_UP,
      relatedEntityType: this.TOP_UP_RELATED_ENTITY_TYPE,
      relatedEntityId: payment.userId,
      paymentTransactionId: payment.id,
      description: `Recharge points FlexPay ${payment.reference}`,
    });

    return this.getOrCreateAccount(payment.userId);
  }

  private async getOrCreateAccount(userId: string): Promise<WalletAccount> {
    let account = await this.accountRepository.findOne({
      where: { userId, type: WalletAccountType.POINTS },
    });

    if (!account) {
      account = this.accountRepository.create({
        userId,
        type: WalletAccountType.POINTS,
        balance: 0,
        currency: this.getPointsCurrency(),
      });
      account = await this.accountRepository.save(account);
    }

    return account;
  }

  private async changeBalance(input: {
    userId: string;
    amount: number;
    type: WalletLedgerEntryType;
    relatedEntityType?: string | null;
    relatedEntityId?: string | null;
    paymentTransactionId?: string | null;
    description?: string | null;
  }): Promise<WalletLedgerEntry> {
    const amount = this.roundMoney(input.amount);
    if (!amount) {
      throw new BadRequestException('Le montant de points est invalide');
    }

    return this.dataSource.transaction(async (manager) => {
      let account = await manager.findOne(WalletAccount, {
        where: { userId: input.userId, type: WalletAccountType.POINTS },
        lock: { mode: 'pessimistic_write' },
      });

      if (!account) {
        account = manager.create(WalletAccount, {
          userId: input.userId,
          type: WalletAccountType.POINTS,
          balance: 0,
          currency: this.getPointsCurrency(),
        });
        account = await manager.save(account);
      }

      const nextBalance = this.roundMoney(Number(account.balance) + amount);
      if (nextBalance < 0) {
        throw new BadRequestException(
          'Solde de points insuffisant pour payer ce trajet',
        );
      }

      account.balance = nextBalance;
      await manager.save(account);

      const entry = manager.create(WalletLedgerEntry, {
        accountId: account.id,
        userId: input.userId,
        accountType: WalletAccountType.POINTS,
        type: input.type,
        amount,
        balanceAfter: nextBalance,
        currency: account.currency,
        relatedEntityType: input.relatedEntityType ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
        paymentTransactionId: input.paymentTransactionId ?? null,
        description: input.description ?? null,
      });

      const savedEntry = await manager.save(entry);
      this.logger.log(
        `Wallet balance changed: userId=${input.userId}, type=${input.type}, amount=${amount}, balanceAfter=${nextBalance}`,
      );
      return savedEntry;
    });
  }

  private async findBookingEntry(
    userId: string,
    bookingId: string,
    type: WalletLedgerEntryType,
  ): Promise<WalletLedgerEntry | null> {
    return this.ledgerRepository.findOne({
      where: {
        userId,
        type,
        relatedEntityType: this.BOOKING_RELATED_ENTITY_TYPE,
        relatedEntityId: bookingId,
      },
      order: { createdAt: 'DESC' },
    });
  }

  private calculateLoyaltyReward(grossAmount: number): number {
    const amount = Number(grossAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return 0;
    }

    return this.roundMoney(amount * this.getLoyaltyRate());
  }

  private getLoyaltyRate(): number {
    const raw =
      this.configService.get<string | number>('ZWANGA_LOYALTY_RATE') ??
      this.DEFAULT_LOYALTY_RATE;
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate < 0) {
      return this.DEFAULT_LOYALTY_RATE;
    }

    return rate;
  }

  private getPointsCurrency(): string {
    return (
      this.configService.get<string>('ZWANGA_POINTS_CURRENCY')?.trim() ||
      this.configService.get<string>('TRIP_PAYMENT_CURRENCY')?.trim() ||
      this.DEFAULT_POINTS_CURRENCY
    ).toUpperCase();
  }

  private getTopUpFlexPayCallbackUrl(): string {
    const explicitUrl = this.configService
      .get<string>('FLEXPAY_WALLET_CALLBACK_URL')
      ?.trim();
    if (explicitUrl) {
      return explicitUrl;
    }

    const configuredBaseUrl =
      this.configService.get<string>('FLEXPAY_CALLBACK_BASE_URL')?.trim() ||
      this.configService.get<string>('PUBLIC_API_BASE_URL')?.trim();

    if (configuredBaseUrl) {
      return this.joinUrl(configuredBaseUrl, 'wallet/topups/flexpay/callback');
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
      'wallet/topups/flexpay/callback',
    );
  }

  private buildPaymentResponse(
    account: WalletAccount,
    payment: PaymentTransaction | null,
  ): WalletPaymentResponse {
    return {
      account,
      payment: {
        transactionId: payment?.id ?? null,
        method: payment?.method ?? null,
        reference: payment?.reference ?? null,
        orderNumber: payment?.orderNumber ?? null,
        status: payment?.status ?? null,
        statusCode: payment?.providerStatusCode ?? null,
        message: payment
          ? this.paymentsService.getClientPaymentMessage(payment)
          : null,
        paymentUrl: payment?.paymentUrl ?? null,
        amount: Number(payment?.amount ?? 0),
        currency: payment?.currency ?? account.currency,
      },
    };
  }

  private logWalletPaymentResponse(
    step: string,
    response: WalletPaymentResponse,
  ): void {
    this.logger.log(
      `${step}: response=${this.paymentsService.formatLogPayload({
        accountId: response.account.id,
        userId: response.account.userId,
        balance: Number(response.account.balance ?? 0),
        currency: response.account.currency,
        payment: response.payment,
      })}`,
    );
  }

  private normalizePositiveAmount(value: number): number {
    const amount = this.roundMoney(Number(value));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Le montant de points est invalide');
    }
    return amount;
  }

  private roundMoney(value: number): number {
    return Math.round(Number(value) * 100) / 100;
  }

  private joinUrl(...parts: string[]): string {
    return parts
      .map((part, index) =>
        index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, ''),
      )
      .filter(Boolean)
      .join('/');
  }
}
