import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  FindOptionsWhere,
  In,
  Repository,
} from 'typeorm';
import {
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { FlexPayCallbackDto } from '../payments/dto/payment.dto';
import { PaymentsService } from '../payments/payments.service';
import {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import {
  WalletAccount,
  WalletAccountType,
} from './entities/wallet-account.entity';
import {
  WalletLedgerEntry,
  WalletLedgerEntryType,
} from './entities/wallet-ledger-entry.entity';
import {
  InitiateWalletTopUpDto,
  TransferWalletPointsDto,
} from './dto/wallet.dto';
import { User } from '../users/entities/user.entity';
import { isSuperAdminRole } from '../users/user-role.policy';
import { applyTokenMovement, refundablePurchasedTokens } from './wallet-origin';
import { hasVerifiedWalletTopUpProof } from '../payments/wallet-topup-proof';

export interface WalletSummary {
  account: WalletAccount;
  recentEntries: WalletLedgerEntry[];
  withdrawal: {
    enabled: boolean;
    currency: string;
    moneyPerToken: number;
    minimumTokens: number;
    availableMoney: number;
    nonWithdrawableTokens: number;
    blocked: boolean;
  };
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

export interface WalletTransferResponse {
  transferId: string;
  amount: number;
  currency: string;
  senderAccount: WalletAccount;
  recipientAccount: WalletAccount;
  senderEntry: WalletLedgerEntry;
  recipientEntry: WalletLedgerEntry;
  recipient: {
    id: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    email: string | null;
  };
}

@Injectable()
export class WalletService implements OnModuleInit {
  private readonly logger = new Logger(WalletService.name);
  private readonly TOP_UP_RELATED_ENTITY_TYPE = 'wallet_top_up';
  private readonly BOOKING_RELATED_ENTITY_TYPE = 'booking';
  private readonly SUBSCRIPTION_RELATED_ENTITY_TYPE = 'subscription';
  private readonly TRANSFER_RELATED_ENTITY_TYPE = 'wallet_transfer';
  private readonly DEFAULT_POINTS_CURRENCY = 'PTS';
  private readonly DEFAULT_POINT_VALUE_CDF = 100;
  private readonly DEFAULT_LOYALTY_RATE = 0.01;
  private readonly DEFAULT_LOYALTY_POINTS_PER_KM = 0.5;
  private readonly DEFAULT_LOYALTY_MIN_REWARD = 1;
  private readonly TRIP_LOYALTY_BASE_REWARD = 1;
  private readonly SUBSCRIPTION_PAYMENT_REWARD_TOKENS = 25;

  constructor(
    @InjectRepository(WalletAccount)
    private readonly accountRepository: Repository<WalletAccount>,
    @InjectRepository(WalletLedgerEntry)
    private readonly ledgerRepository: Repository<WalletLedgerEntry>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly paymentsService: PaymentsService,
  ) {}

  onModuleInit() {
    this.paymentsService.registerSettlement?.(
      PaymentPurpose.WALLET_TOP_UP,
      async (payment) => {
        await this.applyTopUpPayment(payment);
      },
    );
  }

  async getSummary(userId: string): Promise<WalletSummary> {
    const account = await this.getOrCreateAccount(userId);
    const recentEntries = await this.ledgerRepository.find({
      where: { userId, accountType: WalletAccountType.POINTS },
      order: { createdAt: 'DESC' },
      take: 30,
    });

    const currency = this.getPointValueCurrency();
    return {
      account,
      recentEntries,
      withdrawal: {
        enabled:
          this.configService.get<string>('WALLET_WITHDRAWALS_ENABLED') ===
          'true',
        currency,
        moneyPerToken: this.convertPointsToMoney(1, currency),
        minimumTokens: 1,
        availableMoney: this.convertPointsToMoney(
          Number(account.withdrawableBalance ?? 0),
          currency,
        ),
        nonWithdrawableTokens: this.roundMoney(
          Number(account.balance) - Number(account.withdrawableBalance ?? 0),
        ),
        blocked: Boolean(account.withdrawalsBlocked),
      },
    };
  }

  async getLedger(userId: string): Promise<WalletLedgerEntry[]> {
    return this.ledgerRepository.find({
      where: { userId, accountType: WalletAccountType.POINTS },
      order: { createdAt: 'DESC' },
    });
  }

  async applyAdminAdjustment(
    adminId: string,
    userId: string,
    requestedAmount: number,
    requestedReason: string,
    requestId: string,
  ): Promise<WalletAccount> {
    const amount = this.roundMoney(Number(requestedAmount));
    const reason = requestedReason.trim();

    if (
      !Number.isFinite(amount) ||
      amount === 0 ||
      Math.abs(amount) > 1_000_000
    ) {
      throw new BadRequestException(
        "Le montant de l'ajustement doit être différent de zéro",
      );
    }
    if (reason.length < 10 || reason.length > 500) {
      throw new BadRequestException(
        "Le motif de l'ajustement doit contenir entre 10 et 500 caractères",
      );
    }

    const [admin, targetUser] = await Promise.all([
      this.userRepository.findOne({ where: { id: adminId } }),
      this.userRepository.findOne({ where: { id: userId } }),
    ]);
    if (!admin || !isSuperAdminRole(admin.role)) {
      throw new ForbiddenException('Super administrateur requis');
    }
    if (!targetUser) {
      throw new NotFoundException('Utilisateur introuvable');
    }

    return this.dataSource.transaction(async (manager) => {
      const account = await manager.findOne(WalletAccount, {
        where: { userId, type: WalletAccountType.POINTS },
        lock: { mode: 'pessimistic_write' },
      });
      if (!account) {
        throw new NotFoundException('Portefeuille de jetons introuvable');
      }

      const existingEntry = await manager.findOne(WalletLedgerEntry, {
        where: {
          type: WalletLedgerEntryType.ADMIN_ADJUSTMENT,
          relatedEntityType: 'admin_wallet_adjustment',
          relatedEntityId: requestId,
        },
      });
      if (existingEntry) {
        if (existingEntry.userId !== userId) {
          throw new BadRequestException(
            "L'identifiant de demande est déjà associé à un autre portefeuille",
          );
        }
        return account;
      }

      const nextBalance = this.roundMoney(Number(account.balance) + amount);
      if (nextBalance < 0) {
        throw new BadRequestException('Solde de jetons insuffisant');
      }

      const withdrawableAmount = applyTokenMovement(account, amount);
      await manager.save(account);
      await this.createLedgerEntryWithManager(manager, {
        account,
        userId,
        amount,
        balanceAfter: nextBalance,
        type: WalletLedgerEntryType.ADMIN_ADJUSTMENT,
        withdrawableAmount,
        relatedEntityType: 'admin_wallet_adjustment',
        relatedEntityId: requestId,
        description: `Ajustement par admin ${adminId}: ${reason}`,
      });

      this.logger.warn(
        `Admin wallet adjustment applied: requestId=${requestId}, adminId=${adminId}, userId=${userId}, amount=${amount}, balanceAfter=${nextBalance}`,
      );
      return account;
    });
  }

  async initiateTopUp(
    userId: string,
    dto: InitiateWalletTopUpDto,
  ): Promise<WalletPaymentResponse> {
    const pointsAmount = this.normalizePositiveAmount(dto.amount);
    const currency = this.getPointValueCurrency();
    const paymentAmount = this.convertPointsToMoney(pointsAmount, currency);

    const payment = await this.paymentsService.initiatePayment({
      userId,
      purpose: PaymentPurpose.WALLET_TOP_UP,
      relatedEntityType: this.TOP_UP_RELATED_ENTITY_TYPE,
      relatedEntityId: userId,
      method: dto.method,
      phone: dto.phone,
      amount: paymentAmount,
      currency,
      description: `Achat de ${pointsAmount} jetons Zwanga`,
      callbackUrl: this.getTopUpFlexPayCallbackUrl(),
      approveUrl: dto.approveUrl,
      cancelUrl: dto.cancelUrl,
      declineUrl: dto.declineUrl,
      referencePrefix: 'WAL',
      preferredProvider: dto.preferredProvider,
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

  async payForBooking(
    booking: Booking,
    amount: number,
  ): Promise<WalletLedgerEntry | null> {
    return this.dataSource.transaction((manager) =>
      this.payForBookingWithManager(manager, booking, amount),
    );
  }

  /**
   * Debit a booking inside the caller's database transaction.
   *
   * The wallet row is locked before checking the booking ledger. This makes a
   * retry (REST, Socket.IO, cron or provider callback) idempotent and prevents
   * two concurrent requests from spending the same balance.
   */
  async payForBookingWithManager(
    manager: EntityManager,
    booking: Booking,
    amount: number,
  ): Promise<WalletLedgerEntry | null> {
    const pointsAmount = this.convertMoneyToPoints(
      amount,
      booking.paymentCurrency,
    );
    if (pointsAmount <= 0) {
      return null;
    }

    const account = await this.getOrCreateAccountWithManager(
      manager,
      booking.passengerId,
    );

    const existingRefund = await manager.findOne(WalletLedgerEntry, {
      where: {
        userId: booking.passengerId,
        type: WalletLedgerEntryType.BOOKING_REFUND,
        relatedEntityType: this.BOOKING_RELATED_ENTITY_TYPE,
        relatedEntityId: booking.id,
      },
      order: { createdAt: 'DESC' },
    });
    if (existingRefund) {
      throw new BadRequestException(
        'Cette réservation a déjà été remboursée en jetons',
      );
    }

    const existingEntry = await manager.findOne(WalletLedgerEntry, {
      where: {
        userId: booking.passengerId,
        type: WalletLedgerEntryType.BOOKING_PAYMENT,
        relatedEntityType: this.BOOKING_RELATED_ENTITY_TYPE,
        relatedEntityId: booking.id,
      },
      order: { createdAt: 'DESC' },
    });
    if (existingEntry) {
      const expectedDebit = this.roundMoney(-pointsAmount);
      if (this.roundMoney(Number(existingEntry.amount)) !== expectedDebit) {
        throw new BadRequestException(
          'Le montant déjà débité pour cette réservation est incohérent',
        );
      }
      return existingEntry;
    }

    const nextBalance = this.roundMoney(Number(account.balance) - pointsAmount);
    if (nextBalance < 0) {
      throw new BadRequestException('Solde de jetons insuffisant');
    }

    const withdrawableAmount = applyTokenMovement(account, -pointsAmount);
    await manager.save(account);

    const entry = await this.createLedgerEntryWithManager(manager, {
      account,
      userId: booking.passengerId,
      amount: -pointsAmount,
      balanceAfter: nextBalance,
      type: WalletLedgerEntryType.BOOKING_PAYMENT,
      withdrawableAmount,
      relatedEntityType: this.BOOKING_RELATED_ENTITY_TYPE,
      relatedEntityId: booking.id,
      description: `Paiement par jetons pour la réservation ${booking.id} (${amount} ${booking.paymentCurrency ?? this.getPointValueCurrency()})`,
    });

    this.logger.log(
      `TOKEN_BOOKING_DEBIT_COMMITTED bookingId=${booking.id} amountTokens=${pointsAmount}`,
    );
    return entry;
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
      description: `Remboursement en jetons pour la réservation ${booking.id}`,
    });
    return true;
  }

  async creditBookingFareAdjustment(
    booking: Booking,
    amount: number,
  ): Promise<WalletLedgerEntry | null> {
    const pointsAmount = this.convertMoneyToPoints(
      amount,
      booking.paymentCurrency,
    );
    if (pointsAmount <= 0) {
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
      amount: pointsAmount,
      type: WalletLedgerEntryType.BOOKING_FARE_ADJUSTMENT,
      relatedEntityType: this.BOOKING_RELATED_ENTITY_TYPE,
      relatedEntityId: booking.id,
      paymentTransactionId: booking.paymentTransactionId,
      description: `Ajustement du prix kilométrique pour la réservation ${booking.id} (${amount} ${booking.paymentCurrency ?? this.getPointValueCurrency()})`,
    });
  }

  async payForSubscription(
    subscription: { id: string; userId: string },
    amount: number,
  ): Promise<WalletLedgerEntry> {
    const normalizedAmount = this.normalizePositiveAmount(amount);

    const existingEntry = await this.ledgerRepository.findOne({
      where: {
        userId: subscription.userId,
        type: WalletLedgerEntryType.SUBSCRIPTION_PAYMENT,
        relatedEntityType: this.SUBSCRIPTION_RELATED_ENTITY_TYPE,
        relatedEntityId: subscription.id,
      },
      order: { createdAt: 'DESC' },
    });
    if (existingEntry) {
      return existingEntry;
    }

    try {
      return await this.changeBalance({
        userId: subscription.userId,
        amount: -normalizedAmount,
        type: WalletLedgerEntryType.SUBSCRIPTION_PAYMENT,
        relatedEntityType: this.SUBSCRIPTION_RELATED_ENTITY_TYPE,
        relatedEntityId: subscription.id,
        description: `Paiement par jetons pour l’abonnement ${subscription.id}`,
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw new BadRequestException(
          'Solde de jetons insuffisant pour payer cet abonnement',
        );
      }
      throw error;
    }
  }

  async transferPoints(
    senderUserId: string,
    dto: TransferWalletPointsDto,
  ): Promise<WalletTransferResponse> {
    const amount = this.normalizePositiveAmount(dto.amount);
    const recipient = await this.resolveTransferRecipient(dto);

    if (recipient.id === senderUserId) {
      throw new BadRequestException(
        'Impossible de partager des jetons avec votre propre compte',
      );
    }

    const transferId = randomUUID();
    const note = dto.note?.trim();

    return this.dataSource.transaction(async (manager) => {
      const userIds = [senderUserId, recipient.id].sort();
      const accounts = new Map<string, WalletAccount>();

      for (const userId of userIds) {
        accounts.set(
          userId,
          await this.getOrCreateAccountWithManager(manager, userId),
        );
      }

      const senderAccount = accounts.get(senderUserId);
      const recipientAccount = accounts.get(recipient.id);

      if (!senderAccount || !recipientAccount) {
        throw new NotFoundException('Compte de jetons introuvable');
      }

      const senderNextBalance = this.roundMoney(
        Number(senderAccount.balance) - amount,
      );
      if (senderNextBalance < 0) {
        throw new BadRequestException(
          'Solde de jetons insuffisant pour partager des jetons',
        );
      }

      const senderWithdrawableAmount = applyTokenMovement(
        senderAccount,
        -amount,
      );
      await manager.save(senderAccount);
      const senderEntry = await this.createLedgerEntryWithManager(manager, {
        account: senderAccount,
        userId: senderUserId,
        amount: -amount,
        balanceAfter: senderNextBalance,
        type: WalletLedgerEntryType.TRANSFER_OUT,
        withdrawableAmount: senderWithdrawableAmount,
        relatedEntityType: this.TRANSFER_RELATED_ENTITY_TYPE,
        relatedEntityId: transferId,
        description: note
          ? `Partage de jetons vers ${recipient.id}: ${note}`
          : `Partage de jetons vers ${recipient.id}`,
      });

      const recipientNextBalance = this.roundMoney(
        Number(recipientAccount.balance) + amount,
      );
      applyTokenMovement(recipientAccount, amount, -senderWithdrawableAmount);
      await manager.save(recipientAccount);
      const recipientEntry = await this.createLedgerEntryWithManager(manager, {
        account: recipientAccount,
        userId: recipient.id,
        amount,
        balanceAfter: recipientNextBalance,
        type: WalletLedgerEntryType.TRANSFER_IN,
        withdrawableAmount: -senderWithdrawableAmount,
        relatedEntityType: this.TRANSFER_RELATED_ENTITY_TYPE,
        relatedEntityId: transferId,
        description: note
          ? `Jetons reçus de ${senderUserId}: ${note}`
          : `Jetons reçus de ${senderUserId}`,
      });

      this.logger.warn(
        `Wallet tokens transferred: transferId=${transferId}, sender=${senderUserId}, recipient=${recipient.id}, amount=${amount}`,
      );

      return {
        transferId,
        amount,
        currency: senderAccount.currency,
        senderAccount,
        recipientAccount,
        senderEntry,
        recipientEntry,
        recipient: {
          id: recipient.id,
          firstName: recipient.firstName,
          lastName: recipient.lastName,
          phone: recipient.phone ?? null,
          email: recipient.email ?? null,
        },
      };
    });
  }

  async awardLoyaltyForBooking(
    booking: Booking,
    grossAmount: number,
  ): Promise<WalletLedgerEntry | null> {
    if (!this.isCompletedPassengerRide(booking)) return null;
    return this.creditTripLoyalty(
      booking.passengerId,
      booking.tripId,
      this.calculateLoyaltyBonus(booking, grossAmount),
      true,
    );
  }

  async awardBaseLoyaltyForBooking(
    booking: Booking,
  ): Promise<WalletLedgerEntry | null> {
    if (!this.isCompletedPassengerRide(booking)) return null;
    return this.creditTripLoyalty(booking.passengerId, booking.tripId, 0, true);
  }

  async awardLoyaltyForCompletedTrip(
    trip: Trip,
  ): Promise<WalletLedgerEntry | null> {
    // Expired, never-started trips are also marked COMPLETED by the scheduler.
    if (
      trip.status !== TripStatus.COMPLETED ||
      !trip.startedAt ||
      !trip.completedAt
    )
      return null;
    const startedAt = new Date(trip.startedAt).getTime();
    const completedAt = new Date(trip.completedAt).getTime();
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(completedAt) ||
      completedAt < startedAt
    )
      return null;
    return this.creditTripLoyalty(trip.driverId, trip.id, 0, false);
  }

  private isCompletedPassengerRide(booking: Booking): boolean {
    return (
      booking.status === BookingStatus.COMPLETED &&
      !!booking.tripId &&
      Boolean(
        booking.pickedUp ||
        booking.pickedUpAt ||
        booking.pickedUpConfirmedByPassenger ||
        booking.pickedUpConfirmedAt,
      )
    );
  }

  private async creditTripLoyalty(
    userId: string,
    tripId: string,
    bonus: number,
    passenger: boolean,
  ): Promise<WalletLedgerEntry | null> {
    const credits: WalletLedgerEntry[] = [];
    const result = await this.dataSource.transaction(async (manager) => {
      // Lock an existing row even for the first wallet creation. All loyalty
      // retries for this user serialize before checking the immutable ledger.
      const user = await manager.findOne(User, {
        where: { id: userId },
        select: ['id'],
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) throw new NotFoundException('Utilisateur introuvable');

      if (passenger) {
        // Old versions combined base and bonus in a booking-linked entry.
        // Preserve these credits; a callback/retry must not credit them again,
        // even if the passenger has another booking on the same trip.
        const legacy = await manager
          .createQueryBuilder(WalletLedgerEntry, 'entry')
          .innerJoin(Booking, 'booking', 'booking.id = entry.relatedEntityId')
          .where('entry.userId = :userId', { userId })
          .andWhere('entry.type = :type', {
            type: WalletLedgerEntryType.LOYALTY_REWARD,
          })
          .andWhere('entry.relatedEntityType = :entityType', {
            entityType: 'booking',
          })
          .andWhere('booking.tripId = :tripId', { tripId })
          .getOne();
        if (legacy) return legacy;
      }

      const rewards = [
        {
          relatedEntityType: 'trip_loyalty_base',
          amount: this.TRIP_LOYALTY_BASE_REWARD,
        },
      ];
      if (bonus > 0)
        rewards.push({
          relatedEntityType: 'trip_loyalty_bonus',
          amount: bonus,
        });
      let account: WalletAccount | null = null;
      let result: WalletLedgerEntry | null = null;
      for (const reward of rewards) {
        const criteria = {
          userId,
          type: WalletLedgerEntryType.LOYALTY_REWARD,
          relatedEntityType: reward.relatedEntityType,
          relatedEntityId: tripId,
        };
        const existing = await manager.findOne(WalletLedgerEntry, {
          where: criteria,
        });
        if (existing) {
          result = existing;
          continue;
        }

        account ??= await this.getOrCreateAccountWithManager(manager, userId);
        applyTokenMovement(account, reward.amount);
        await manager.save(account);
        result = await this.createLedgerEntryWithManager(manager, {
          account,
          ...criteria,
          amount: reward.amount,
          balanceAfter: account.balance,
          description:
            reward.relatedEntityType === 'trip_loyalty_base'
              ? `Jeton de fidélité pour le trajet ${tripId}`
              : `Bonus de fidélité pour le trajet ${tripId}`,
        });
        credits.push(result);
      }
      return result;
    });
    for (const entry of credits) {
      this.logger.warn(
        `TRIP_LOYALTY_COMMITTED userId=${userId} tripId=${tripId} component=${entry.relatedEntityType} amount=${entry.amount}`,
      );
    }
    return result;
  }

  async ensureSufficientPoints(userId: string, amount: number): Promise<void> {
    const account = await this.getOrCreateAccount(userId);
    if (Number(account.balance) < amount) {
      throw new BadRequestException('Solde de jetons insuffisant');
    }
  }

  public getPointsCurrency(): string {
    return (
      this.configService.get<string>('ZWANGA_POINTS_CURRENCY')?.trim() ||
      this.DEFAULT_POINTS_CURRENCY
    ).toUpperCase();
  }

  async awardSubscriptionPaymentTokens(
    subscription: {
      id: string;
      userId: string;
    },
    paymentTransactionId?: string | null,
  ): Promise<WalletLedgerEntry> {
    const entryCriteria = {
      userId: subscription.userId,
      type: WalletLedgerEntryType.SUBSCRIPTION_REWARD,
      relatedEntityType: this.SUBSCRIPTION_RELATED_ENTITY_TYPE,
      relatedEntityId: subscription.id,
    };
    const existingEntry = await this.ledgerRepository.findOne({
      where: entryCriteria,
      order: { createdAt: 'DESC' },
    });
    if (existingEntry) {
      return existingEntry;
    }

    try {
      return await this.changeBalance({
        userId: subscription.userId,
        amount: this.SUBSCRIPTION_PAYMENT_REWARD_TOKENS,
        type: WalletLedgerEntryType.SUBSCRIPTION_REWARD,
        relatedEntityType: this.SUBSCRIPTION_RELATED_ENTITY_TYPE,
        relatedEntityId: subscription.id,
        paymentTransactionId: paymentTransactionId ?? null,
        description: `Bonus de 25 jetons pour l’abonnement ${subscription.id}`,
      });
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        const concurrentEntry = await this.ledgerRepository.findOne({
          where: entryCriteria,
          order: { createdAt: 'DESC' },
        });
        if (concurrentEntry) {
          return concurrentEntry;
        }
      }
      throw error;
    }
  }

  public getSubscriptionPaymentRewardTokens(): number {
    return this.SUBSCRIPTION_PAYMENT_REWARD_TOKENS;
  }

  public convertMoneyToPoints(
    amount: number,
    currency?: string | null,
  ): number {
    const normalizedAmount = this.normalizeNonNegativeAmount(amount);
    if (normalizedAmount <= 0) {
      return 0;
    }
    return this.roundMoney(
      normalizedAmount / this.getPointValueForCurrency(currency),
    );
  }

  public convertPointsToMoney(
    points: number,
    currency?: string | null,
  ): number {
    const normalizedPoints = this.normalizeNonNegativeAmount(points);
    if (normalizedPoints <= 0) {
      return 0;
    }
    return this.roundMoney(
      normalizedPoints * this.getPointValueForCurrency(currency),
    );
  }

  private async resolveTransferRecipient(
    dto: TransferWalletPointsDto,
  ): Promise<User> {
    const where: FindOptionsWhere<User>[] = [];
    const recipientUserId = dto.recipientUserId?.trim();
    const recipientPhone = dto.recipientPhone?.trim();
    const recipientEmail = dto.recipientEmail?.trim().toLowerCase();

    if (recipientUserId) {
      where.push({ id: recipientUserId, isActive: true });
    }
    if (recipientPhone) {
      where.push({
        phone: In(this.buildPhoneSearchCandidates(recipientPhone)),
        isActive: true,
      });
    }
    if (recipientEmail) {
      where.push({ email: recipientEmail, isActive: true });
    }

    if (!where.length) {
      throw new BadRequestException(
        'Veuillez renseigner le destinataire des jetons',
      );
    }

    const recipient = await this.userRepository.findOne({ where });
    if (!recipient) {
      throw new NotFoundException('Utilisateur destinataire introuvable');
    }

    return recipient;
  }

  private buildPhoneSearchCandidates(phone: string): string[] {
    const candidates = new Set<string>();
    const trimmed = phone.trim();
    const compact = trimmed.replace(/[\s().-]/g, '');
    const digits = compact.replace(/\D/g, '');
    const defaultCountryCode = (
      this.configService.get<string>('DEFAULT_COUNTRY_CODE') || '+243'
    ).replace(/\D/g, '');

    if (trimmed) {
      candidates.add(trimmed);
    }
    if (compact) {
      candidates.add(compact);
    }
    if (!digits) {
      return [...candidates];
    }

    candidates.add(digits);

    const addInternationalVariants = (internationalDigits: string) => {
      if (!internationalDigits) {
        return;
      }
      candidates.add(`+${internationalDigits}`);
      candidates.add(internationalDigits);

      if (internationalDigits.startsWith(defaultCountryCode)) {
        const nationalDigits = internationalDigits.slice(
          defaultCountryCode.length,
        );
        if (nationalDigits) {
          candidates.add(nationalDigits);
          candidates.add(`0${nationalDigits}`);
        }
      }
    };

    if (digits.startsWith('00')) {
      addInternationalVariants(digits.slice(2));
    } else if (digits.startsWith(defaultCountryCode)) {
      addInternationalVariants(digits);
    } else if (digits.startsWith('0')) {
      addInternationalVariants(`${defaultCountryCode}${digits.slice(1)}`);
      candidates.add(digits);
    } else {
      addInternationalVariants(`${defaultCountryCode}${digits}`);
    }

    return [...candidates];
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
        'Cette transaction ne correspond pas à une recharge de jetons',
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

    // Old succeeded payments could have been marked from unverified callbacks.
    // Never grant a new cash-redeemable credit from that local status alone.
    if (!hasVerifiedWalletTopUpProof(payment)) {
      throw new BadRequestException(
        'La recharge doit être confirmée par le prestataire de paiement avant de créditer des jetons retirables',
      );
    }

    await this.changeBalance({
      userId: payment.userId,
      amount: this.convertMoneyToPoints(
        Number(payment.amount),
        payment.currency,
      ),
      type: WalletLedgerEntryType.TOP_UP,
      relatedEntityType: this.TOP_UP_RELATED_ENTITY_TYPE,
      relatedEntityId: payment.userId,
      paymentTransactionId: payment.id,
      description: `Recharge de jetons ${payment.provider === 'pawapay' ? 'PawaPay' : 'FlexPay'} ${payment.reference}`,
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

  private async getOrCreateAccountWithManager(
    manager: EntityManager,
    userId: string,
  ): Promise<WalletAccount> {
    let account = await manager.findOne(WalletAccount, {
      where: { userId, type: WalletAccountType.POINTS },
      lock: { mode: 'pessimistic_write' },
    });

    if (!account) {
      account = manager.create(WalletAccount, {
        userId,
        type: WalletAccountType.POINTS,
        balance: 0,
        currency: this.getPointsCurrency(),
      });
      account = await manager.save(account);
    }

    return account;
  }

  private async createLedgerEntryWithManager(
    manager: EntityManager,
    input: {
      account: WalletAccount;
      userId: string;
      amount: number;
      withdrawableAmount?: number;
      balanceAfter: number;
      type: WalletLedgerEntryType;
      relatedEntityType?: string | null;
      relatedEntityId?: string | null;
      paymentTransactionId?: string | null;
      description?: string | null;
    },
  ): Promise<WalletLedgerEntry> {
    const entry = manager.create(WalletLedgerEntry, {
      accountId: input.account.id,
      userId: input.userId,
      accountType: WalletAccountType.POINTS,
      type: input.type,
      amount: this.roundMoney(input.amount),
      withdrawableAmount: input.withdrawableAmount ?? 0,
      balanceAfter: this.roundMoney(input.balanceAfter),
      currency: input.account.currency,
      relatedEntityType: input.relatedEntityType ?? null,
      relatedEntityId: input.relatedEntityId ?? null,
      paymentTransactionId: input.paymentTransactionId ?? null,
      description: input.description ?? null,
    });

    return manager.save(entry);
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
    let amount = this.roundMoney(input.amount);
    if (!amount) {
      throw new BadRequestException('Le montant de jetons est invalide');
    }

    return this.dataSource.transaction(async (manager) => {
      // Serialize fare-adjustment retries even when this passenger has no wallet yet.
      // All callers lock the booking before the wallet, and recheck the ledger inside the transaction.
      if (
        input.type === WalletLedgerEntryType.BOOKING_FARE_ADJUSTMENT &&
        input.relatedEntityId
      ) {
        await manager.findOne(Booking, {
          where: { id: input.relatedEntityId },
          lock: { mode: 'pessimistic_write' },
        });
        const existing = await manager.findOne(WalletLedgerEntry, {
          where: {
            userId: input.userId,
            type: input.type,
            relatedEntityType: input.relatedEntityType!,
            relatedEntityId: input.relatedEntityId,
          },
        });
        if (existing) return existing;
      }
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

      // Every balance writer serializes on the account before checking retries.
      const duplicate = await manager.findOne(WalletLedgerEntry, {
        where:
          input.type === WalletLedgerEntryType.TOP_UP
            ? {
                type: input.type,
                paymentTransactionId: input.paymentTransactionId!,
              }
            : {
                userId: input.userId,
                type: input.type,
                relatedEntityType: input.relatedEntityType!,
                relatedEntityId: input.relatedEntityId!,
              },
      });
      if (duplicate) return duplicate;

      let purchasedCredit =
        input.type === WalletLedgerEntryType.TOP_UP ? amount : 0;
      if (
        [
          WalletLedgerEntryType.BOOKING_REFUND,
          WalletLedgerEntryType.BOOKING_FARE_ADJUSTMENT,
        ].includes(input.type)
      ) {
        const debit = await manager.findOne(WalletLedgerEntry, {
          where: {
            userId: input.userId,
            type: WalletLedgerEntryType.BOOKING_PAYMENT,
            relatedEntityType: 'booking',
            relatedEntityId: input.relatedEntityId!,
          },
        });
        if (debit) {
          const refunds = await manager.find(WalletLedgerEntry, {
            where: {
              userId: input.userId,
              relatedEntityType: 'booking',
              relatedEntityId: input.relatedEntityId!,
              type: In([
                WalletLedgerEntryType.BOOKING_REFUND,
                WalletLedgerEntryType.BOOKING_FARE_ADJUSTMENT,
              ]),
            },
          });
          if (input.type === WalletLedgerEntryType.BOOKING_REFUND) {
            amount = this.roundMoney(
              Math.abs(Number(debit.amount)) -
                refunds.reduce((sum, entry) => sum + Number(entry.amount), 0),
            );
            if (amount <= 0)
              throw new BadRequestException(
                'Cette réservation est déjà entièrement remboursée',
              );
          }
          purchasedCredit = refundablePurchasedTokens(debit, refunds, amount);
        }
        // Legacy allocations and electronic fare credits without a token debit
        // remain non-withdrawable: no guessed provenance.
      }

      const nextBalance = this.roundMoney(Number(account.balance) + amount);
      if (nextBalance < 0) {
        throw new BadRequestException('Solde de jetons insuffisant');
      }

      const withdrawableAmount = applyTokenMovement(
        account,
        amount,
        purchasedCredit,
      );
      await manager.save(account);

      const entry = manager.create(WalletLedgerEntry, {
        accountId: account.id,
        userId: input.userId,
        accountType: WalletAccountType.POINTS,
        type: input.type,
        amount,
        withdrawableAmount,
        balanceAfter: nextBalance,
        currency: account.currency,
        relatedEntityType: input.relatedEntityType ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
        paymentTransactionId: input.paymentTransactionId ?? null,
        description: input.description ?? null,
      });

      const savedEntry = await manager.save(entry);
      this.logger.warn(
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

  private calculateLoyaltyBonus(booking: Booking, grossAmount: number): number {
    if (
      ![TripPaymentMode.POINTS, TripPaymentMode.ELECTRONIC].includes(
        booking.paymentMode,
      ) ||
      booking.paymentStatus !== BookingPaymentStatus.SUCCEEDED ||
      !Number.isFinite(Number(grossAmount)) ||
      Number(grossAmount) <= 0
    )
      return 0;
    const distanceReward = this.calculateDistanceLoyaltyReward(booking);
    if (distanceReward > 0) {
      return distanceReward;
    }

    const amount = Number(grossAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return 0;
    }

    const loyaltyMoneyValue = this.roundMoney(amount * this.getLoyaltyRate());
    if (loyaltyMoneyValue <= 0) {
      return 0;
    }

    return this.roundMoney(
      this.convertMoneyToPoints(loyaltyMoneyValue, booking.paymentCurrency),
    );
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === '23505',
    );
  }

  private calculateDistanceLoyaltyReward(booking: Booking): number {
    const distanceMeters = Number(
      booking.travelledDistanceMeters ?? booking.plannedDistanceMeters ?? 0,
    );
    if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
      return 0;
    }

    const pointsPerKm = this.getLoyaltyPointsPerKm();
    if (pointsPerKm <= 0) {
      return 0;
    }

    const reward = this.roundMoney((distanceMeters / 1000) * pointsPerKm);
    return Math.max(this.getLoyaltyMinReward(), reward);
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

  private getLoyaltyPointsPerKm(): number {
    const raw =
      this.configService.get<string | number>('ZWANGA_LOYALTY_POINTS_PER_KM') ??
      this.DEFAULT_LOYALTY_POINTS_PER_KM;
    const pointsPerKm = Number(raw);
    if (!Number.isFinite(pointsPerKm) || pointsPerKm < 0) {
      return this.DEFAULT_LOYALTY_POINTS_PER_KM;
    }

    return pointsPerKm;
  }

  private getLoyaltyMinReward(): number {
    const raw =
      this.configService.get<string | number>('ZWANGA_LOYALTY_MIN_REWARD') ??
      this.DEFAULT_LOYALTY_MIN_REWARD;
    const minReward = Number(raw);
    if (!Number.isFinite(minReward) || minReward < 0) {
      return this.DEFAULT_LOYALTY_MIN_REWARD;
    }

    return minReward;
  }

  private getPointValueCurrency(): string {
    return (
      this.configService.get<string>('ZWANGA_POINT_VALUE_CURRENCY')?.trim() ||
      this.configService.get<string>('TRIP_PAYMENT_CURRENCY')?.trim() ||
      'CDF'
    ).toUpperCase();
  }

  private getPointValueForCurrency(currency?: string | null): number {
    const normalizedCurrency = (
      currency?.trim() || this.getPointValueCurrency()
    ).toUpperCase();
    const raw =
      this.configService.get<string | number>(
        `ZWANGA_POINT_VALUE_${normalizedCurrency}`,
      ) ??
      this.configService.get<string | number>('ZWANGA_POINT_VALUE') ??
      (normalizedCurrency === 'CDF' ? this.DEFAULT_POINT_VALUE_CDF : undefined);
    const pointValue = Number(raw);
    if (!Number.isFinite(pointValue) || pointValue <= 0) {
      throw new BadRequestException(
        `Valeur du jeton non configurée pour ${normalizedCurrency}`,
      );
    }

    return pointValue;
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
    this.logger.warn(
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
      throw new BadRequestException('Le montant de jetons est invalide');
    }
    return amount;
  }

  private normalizeNonNegativeAmount(value: number): number {
    const amount = this.roundMoney(Number(value));
    if (!Number.isFinite(amount) || amount < 0) {
      throw new BadRequestException('Le montant de jetons est invalide');
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
