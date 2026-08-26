import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/entities/booking.entity';
import { NotificationService } from '../notifications/notifications.service';
import {
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { FlexPayCallbackDto } from '../payments/dto/payment.dto';
import { PaymentsService } from '../payments/payments.service';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import { User } from '../users/entities/user.entity';
import {
  DriverEarning,
  DriverEarningStatus,
} from './entities/driver-earning.entity';
import {
  DriverPayout,
  DriverPayoutStatus,
} from './entities/driver-payout.entity';
import { RequestDriverPayoutDto } from './dto/driver-settlement.dto';

export interface DriverSettlementSummary {
  availableBalance: number;
  pendingPayoutBalance: number;
  paidBalance: number;
  currency: string;
  commissionRate: number;
  kycApproved: boolean;
  payoutPhone: string | null;
  minimumPayoutAmount: number;
}

export interface DriverTripRevenueSummary {
  tripId: string;
  currency: string;
  commissionRate: number;
  confirmedAmount: number;
  cashToCollectAmount: number;
  electronicPendingAmount: number;
  totalExpectedAmount: number;
  completedBookings: number;
  generatedAt: string;
}

export type DriverPayoutResponse = DriverPayout & {
  orderNumber: string | null;
  paymentMessage: string | null;
};

@Injectable()
export class DriverSettlementsService {
  private readonly logger = new Logger(DriverSettlementsService.name);
  private readonly PAYOUT_RELATED_ENTITY_TYPE = 'driver_payout';
  private readonly DEFAULT_COMMISSION_RATE = 0.05;
  private readonly DEFAULT_CURRENCY = 'CDF';
  private readonly DEFAULT_MINIMUM_PAYOUT_AMOUNT = 1;
  private readonly ORPHAN_PAYOUT_GRACE_MS = 15 * 60 * 1000;
  private payoutReconciliationRunning = false;

  constructor(
    @InjectRepository(DriverEarning)
    private readonly earningRepository: Repository<DriverEarning>,
    @InjectRepository(DriverPayout)
    private readonly payoutRepository: Repository<DriverPayout>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(KycDocument)
    private readonly kycRepository: Repository<KycDocument>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(Trip)
    private readonly tripRepository: Repository<Trip>,
    private readonly configService: ConfigService,
    private readonly paymentsService: PaymentsService,
    private readonly dataSource: DataSource,
    private readonly notificationService: NotificationService,
  ) {}

  async getSummary(driverId: string): Promise<DriverSettlementSummary> {
    const currency = this.getCurrency();
    const [
      availableBalance,
      pendingPayoutBalance,
      paidBalance,
      kycApproved,
      driver,
    ] = await Promise.all([
      this.getAvailableBalance(driverId),
      this.sumPayouts(driverId, [
        DriverPayoutStatus.PENDING,
        DriverPayoutStatus.INITIATED,
      ]),
      this.sumPayouts(driverId, [DriverPayoutStatus.SUCCEEDED]),
      this.kycRepository.exists({
        where: { userId: driverId, status: KycStatus.APPROVED },
      }),
      this.userRepository.findOne({ where: { id: driverId } }),
    ]);

    return {
      availableBalance,
      pendingPayoutBalance,
      paidBalance,
      currency,
      commissionRate: this.getCommissionRate(),
      kycApproved,
      payoutPhone: driver?.phone ?? null,
      minimumPayoutAmount: this.getMinimumPayoutAmount(),
    };
  }

  async findDriverEarnings(driverId: string): Promise<DriverEarning[]> {
    return this.earningRepository.find({
      where: { driverId },
      order: { createdAt: 'DESC' },
    });
  }

  async findDriverPayouts(driverId: string): Promise<DriverPayoutResponse[]> {
    const payouts = await this.payoutRepository.find({
      where: { driverId },
      relations: ['paymentTransaction'],
      order: { createdAt: 'DESC' },
    });
    return payouts.map((payout) => this.formatPayoutForClient(payout));
  }

  async getTripRevenueSummary(
    driverId: string,
    tripId: string,
  ): Promise<DriverTripRevenueSummary> {
    const trip = await this.tripRepository.findOne({
      where: { id: tripId, driverId },
      select: ['id', 'driverId', 'pricePerSeat', 'isFree'],
    });
    if (!trip) {
      throw new NotFoundException(
        "Trajet introuvable ou vous n'en etes pas le conducteur",
      );
    }

    const bookings = await this.bookingRepository.find({
      where: { tripId },
      relations: ['trip'],
    });
    return this.buildTripRevenueSummary(trip, bookings);
  }

  async notifyDriverTripRevenue(
    driverId: string,
    tripId: string,
  ): Promise<DriverTripRevenueSummary | null> {
    try {
      const summary = await this.getTripRevenueSummary(driverId, tripId);
      const driver = await this.userRepository.findOne({
        where: { id: driverId },
        select: ['id', 'fcmToken'],
      });

      if (!driver?.fcmToken) {
        this.logger.debug(
          `Driver ${driverId} has no FCM token; trip revenue remains available through the app`,
        );
        return summary;
      }

      const title = 'Montant du trajet';
      const body = this.buildTripRevenueNotificationBody(summary);
      await this.notificationService.sendNotification(
        driver.fcmToken,
        title,
        body,
        {
          type: 'driver_trip_revenue',
          role: 'driver',
          driverId,
          tripId,
          currency: summary.currency,
          confirmedAmount: summary.confirmedAmount,
          cashToCollectAmount: summary.cashToCollectAmount,
          electronicPendingAmount: summary.electronicPendingAmount,
          totalExpectedAmount: summary.totalExpectedAmount,
        },
        driverId,
      );
      return summary;
    } catch (error) {
      this.logger.error(
        `DRIVER_TRIP_REVENUE_NOTIFICATION_FAILED tripId=${tripId} driverId=${driverId} reason=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private buildTripRevenueSummary(
    trip: Trip,
    bookings: Booking[],
  ): DriverTripRevenueSummary {
    const commissionRate = this.getCommissionRate();
    const currency = this.getCurrency();
    let confirmedAmount = 0;
    let cashToCollectAmount = 0;
    let electronicPendingAmount = 0;
    let completedBookings = 0;

    for (const booking of bookings) {
      if (!this.hasCompletedRide(booking)) {
        continue;
      }

      const grossAmount = this.resolveTripBookingGrossAmount(booking, trip);
      if (grossAmount <= 0) {
        continue;
      }

      completedBookings += 1;
      if (booking.paymentMode === TripPaymentMode.CASH) {
        cashToCollectAmount += grossAmount;
        continue;
      }

      const netAmount = this.roundMoney(grossAmount * (1 - commissionRate));
      if (booking.paymentStatus === BookingPaymentStatus.SUCCEEDED) {
        confirmedAmount += netAmount;
      } else if (booking.paymentMode === TripPaymentMode.ELECTRONIC) {
        electronicPendingAmount += netAmount;
      }
    }

    confirmedAmount = this.roundMoney(confirmedAmount);
    cashToCollectAmount = this.roundMoney(cashToCollectAmount);
    electronicPendingAmount = this.roundMoney(electronicPendingAmount);

    return {
      tripId: trip.id,
      currency,
      commissionRate,
      confirmedAmount,
      cashToCollectAmount,
      electronicPendingAmount,
      totalExpectedAmount: this.roundMoney(
        confirmedAmount + cashToCollectAmount + electronicPendingAmount,
      ),
      completedBookings,
      generatedAt: new Date().toISOString(),
    };
  }

  private hasCompletedRide(booking: Booking): boolean {
    return Boolean(
      booking.status === BookingStatus.COMPLETED ||
      booking.droppedOff ||
      booking.droppedOffConfirmedByPassenger ||
      booking.droppedOffAt ||
      booking.droppedOffConfirmedAt,
    );
  }

  private resolveTripBookingGrossAmount(booking: Booking, trip: Trip): number {
    const persistedAmount = Number(booking.paymentAmount);
    if (Number.isFinite(persistedAmount) && persistedAmount > 0) {
      return this.roundMoney(persistedAmount);
    }

    if (trip.isFree) {
      return 0;
    }

    const pricePerSeat = Number(
      trip.pricePerSeat ?? booking.trip?.pricePerSeat,
    );
    const seats = Math.max(1, Number(booking.numberOfSeats) || 1);
    return Number.isFinite(pricePerSeat) && pricePerSeat > 0
      ? this.roundMoney(pricePerSeat * seats)
      : 0;
  }

  private buildTripRevenueNotificationBody(
    summary: DriverTripRevenueSummary,
  ): string {
    const parts: string[] = [];
    if (summary.confirmedAmount > 0) {
      parts.push(
        `${this.formatMoney(summary.confirmedAmount)} ${summary.currency} ajoutes a vos gains`,
      );
    }
    if (summary.cashToCollectAmount > 0) {
      parts.push(
        `${this.formatMoney(summary.cashToCollectAmount)} ${summary.currency} a encaisser en liquide`,
      );
    }
    if (summary.electronicPendingAmount > 0) {
      parts.push(
        `${this.formatMoney(summary.electronicPendingAmount)} ${summary.currency} en attente du paiement electronique`,
      );
    }

    return parts.length > 0
      ? `${parts.join('. ')}.`
      : `Aucun montant a encaisser pour ce trajet (0 ${summary.currency}).`;
  }

  private formatMoney(value: number): string {
    return this.roundMoney(value).toLocaleString('fr-FR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  }

  async recordCompletedBookingEarning(
    booking: Booking,
  ): Promise<DriverEarning | null> {
    return this.recordCompletedBookingEarningUsingRepository(booking);
  }

  /**
   * Record the driver's receivable in an existing transaction. Booking
   * payment code uses this variant so passenger debit and driver credit are
   * committed or rolled back together.
   */
  async recordCompletedBookingEarningWithManager(
    manager: EntityManager,
    booking: Booking,
  ): Promise<DriverEarning | null> {
    if (
      ![TripPaymentMode.ELECTRONIC, TripPaymentMode.POINTS].includes(
        booking.paymentMode,
      )
    ) {
      return null;
    }

    if (booking.paymentStatus !== BookingPaymentStatus.SUCCEEDED) {
      this.logger.warn(
        `Driver earning skipped for booking ${booking.id}: booking is not paid`,
      );
      return null;
    }

    const existing = await manager.findOne(DriverEarning, {
      where: { bookingId: booking.id },
    });
    if (existing) {
      this.assertEarningMatchesBooking(existing, booking);
      return existing;
    }

    const earningData = this.buildEarningData(booking);
    if (!earningData) {
      return null;
    }

    const earning = manager.create(DriverEarning, earningData);
    const saved = await manager.save(earning);
    this.logRecordedEarning(saved);
    return saved;
  }

  private async recordCompletedBookingEarningUsingRepository(
    booking: Booking,
  ): Promise<DriverEarning | null> {
    if (
      ![TripPaymentMode.ELECTRONIC, TripPaymentMode.POINTS].includes(
        booking.paymentMode,
      )
    ) {
      return null;
    }

    if (booking.paymentStatus !== BookingPaymentStatus.SUCCEEDED) {
      this.logger.warn(
        `Driver earning skipped for booking ${booking.id}: booking is not paid`,
      );
      return null;
    }

    const existing = await this.earningRepository.findOne({
      where: { bookingId: booking.id },
    });
    if (existing) {
      this.assertEarningMatchesBooking(existing, booking);
      return existing;
    }

    const earningData = this.buildEarningData(booking);
    if (!earningData) {
      return null;
    }

    const earning = this.earningRepository.create(earningData);
    const saved = await this.earningRepository.save(earning);
    this.logRecordedEarning(saved);
    if (booking.trip?.status === TripStatus.COMPLETED) {
      await this.notifyDriverBookingEarningAvailable(saved);
    }
    return saved;
  }

  private async notifyDriverBookingEarningAvailable(
    earning: DriverEarning,
  ): Promise<void> {
    try {
      const driver = await this.userRepository.findOne({
        where: { id: earning.driverId },
        select: ['id', 'fcmToken'],
      });
      if (!driver?.fcmToken) {
        return;
      }

      const netAmount = this.roundMoney(Number(earning.netAmount));
      await this.notificationService.sendNotification(
        driver.fcmToken,
        'Paiement du trajet confirmé',
        `${this.formatMoney(netAmount)} ${earning.currency} sont maintenant disponibles dans vos gains.`,
        {
          type: 'driver_booking_earning_confirmed',
          role: 'driver',
          driverId: earning.driverId,
          tripId: earning.tripId,
          bookingId: earning.bookingId,
          amount: netAmount,
          currency: earning.currency,
        },
        earning.driverId,
      );
    } catch (error) {
      this.logger.error(
        `DRIVER_EARNING_NOTIFICATION_FAILED earningId=${earning.id} reason=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private buildEarningData(
    booking: Booking,
  ): Omit<DriverEarning, 'id' | 'createdAt' | 'updatedAt'> | null {
    const grossAmount = this.normalizeAmount(
      Number(booking.paymentAmount ?? 0),
    );
    if (grossAmount <= 0) {
      return null;
    }

    const commissionRate = this.getCommissionRate();
    const commissionAmount = this.roundMoney(grossAmount * commissionRate);
    const netAmount = this.roundMoney(grossAmount - commissionAmount);

    if (!booking.trip?.driverId) {
      throw new BadRequestException(
        `Conducteur introuvable pour la reservation ${booking.id}`,
      );
    }

    return {
      bookingId: booking.id,
      tripId: booking.tripId,
      driverId: booking.trip.driverId,
      passengerId: booking.passengerId,
      paymentMode: booking.paymentMode,
      grossAmount,
      commissionRate,
      commissionAmount,
      netAmount,
      currency: booking.paymentCurrency || this.getCurrency(),
      status: DriverEarningStatus.AVAILABLE,
      availableAt: new Date(),
      paidAt: null,
    };
  }

  private assertEarningMatchesBooking(
    earning: DriverEarning,
    booking: Booking,
  ): void {
    const expectedGross = this.normalizeAmount(
      Number(booking.paymentAmount ?? 0),
    );
    const expectedDriverId = booking.trip?.driverId;
    if (
      this.roundMoney(Number(earning.grossAmount)) !== expectedGross ||
      earning.tripId !== booking.tripId ||
      earning.passengerId !== booking.passengerId ||
      (expectedDriverId && earning.driverId !== expectedDriverId)
    ) {
      throw new BadRequestException(
        `Le gain conducteur existant est incoherent pour la reservation ${booking.id}`,
      );
    }
  }

  private logRecordedEarning(earning: DriverEarning): void {
    this.logger.log(
      `DRIVER_EARNING_COMMITTED bookingId=${earning.bookingId} gross=${Number(earning.grossAmount)} commission=${Number(earning.commissionAmount)} net=${Number(earning.netAmount)}`,
    );
  }

  async requestPayout(
    driverId: string,
    dto: RequestDriverPayoutDto,
  ): Promise<DriverPayoutResponse> {
    const amount = this.normalizeAmount(dto.amount);
    if (amount < this.getMinimumPayoutAmount()) {
      throw new BadRequestException(
        `Le retrait minimum est de ${this.getMinimumPayoutAmount()} ${this.getCurrency()}`,
      );
    }

    const payout = await this.reservePayout(
      driverId,
      amount,
      dto.phone,
      dto.idempotencyKey?.trim() || randomUUID(),
    );

    if (
      [
        DriverPayoutStatus.SUCCEEDED,
        DriverPayoutStatus.FAILED,
        DriverPayoutStatus.CANCELLED,
      ].includes(payout.status)
    ) {
      return this.formatPayoutForClient(payout);
    }

    const existingPayment =
      payout.paymentTransaction ??
      (await this.paymentsService.findLatestTransactionForRelatedEntity(
        this.PAYOUT_RELATED_ENTITY_TYPE,
        payout.id,
        driverId,
      ));

    if (existingPayment) {
      return this.applyPaymentToPayout(existingPayment, driverId);
    }

    try {
      const payment = await this.paymentsService.initiatePayout({
        userId: driverId,
        purpose: PaymentPurpose.DRIVER_PAYOUT,
        relatedEntityType: this.PAYOUT_RELATED_ENTITY_TYPE,
        relatedEntityId: payout.id,
        phone: payout.phone,
        amount,
        currency: payout.currency,
        description: `Paiement chauffeur Zwanga ${payout.id}`,
        callbackUrl: this.getPayoutFlexPayCallbackUrl(),
        referencePrefix: 'DRV',
      });

      const savedPayout = await this.applyPaymentToPayout(payment, driverId);
      this.logDriverPayoutResponse(
        'Driver payout initialized',
        savedPayout,
        payment,
      );
      return savedPayout;
    } catch (error) {
      const payment =
        await this.paymentsService.findLatestTransactionForRelatedEntity(
          this.PAYOUT_RELATED_ENTITY_TYPE,
          payout.id,
          driverId,
        );
      if (payment) {
        const reconciled = await this.applyPaymentToPayout(payment, driverId);
        if (
          [DriverPayoutStatus.PENDING, DriverPayoutStatus.INITIATED].includes(
            reconciled.status,
          )
        ) {
          return reconciled;
        }
      } else {
        await this.markUnsentPayoutFailed(
          payout.id,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }

  async handlePayoutCallback(
    dto: FlexPayCallbackDto,
  ): Promise<DriverPayoutResponse> {
    const payment = await this.paymentsService.handleFlexPayCallback(dto);
    const payout = await this.applyPaymentToPayout(payment);
    this.logDriverPayoutResponse(
      'Driver payout callback applied',
      payout,
      payment,
    );
    return payout;
  }

  async checkPayoutStatus(
    driverId: string,
    orderNumber: string,
  ): Promise<DriverPayoutResponse> {
    const payment = await this.paymentsService.checkPaymentStatus(
      orderNumber,
      driverId,
    );
    const payout = await this.applyPaymentToPayout(payment, driverId);
    this.logDriverPayoutResponse('Driver payout status check', payout, payment);
    return payout;
  }

  private async applyPaymentToPayout(
    payment: PaymentTransaction,
    driverId?: string,
  ): Promise<DriverPayoutResponse> {
    if (
      payment.purpose !== String(PaymentPurpose.DRIVER_PAYOUT) ||
      payment.relatedEntityType !== this.PAYOUT_RELATED_ENTITY_TYPE
    ) {
      throw new BadRequestException(
        'Cette transaction ne correspond pas a un paiement chauffeur',
      );
    }

    const payout = await this.dataSource.transaction(async (manager) => {
      const foundPayout = await manager.findOne(DriverPayout, {
        where: [
          ...(payment.relatedEntityId
            ? [
                {
                  id: payment.relatedEntityId,
                  ...(driverId ? { driverId } : {}),
                },
              ]
            : []),
          {
            paymentTransactionId: payment.id,
            ...(driverId ? { driverId } : {}),
          },
        ],
        lock: { mode: 'pessimistic_write' },
      });
      if (!foundPayout) {
        throw new NotFoundException('Paiement chauffeur introuvable');
      }

      if (
        foundPayout.status === DriverPayoutStatus.SUCCEEDED &&
        payment.status !== PaymentStatus.SUCCEEDED
      ) {
        return foundPayout;
      }

      foundPayout.paymentTransactionId = payment.id;
      foundPayout.status = this.mapPaymentStatus(payment.status);
      foundPayout.failureReason = [
        PaymentStatus.FAILED,
        PaymentStatus.CANCELLED,
      ].includes(payment.status)
        ? payment.providerMessage
        : null;
      foundPayout.processedAt =
        payment.status === PaymentStatus.SUCCEEDED
          ? (payment.paidAt ?? new Date())
          : [PaymentStatus.FAILED, PaymentStatus.CANCELLED].includes(
                payment.status,
              )
            ? (foundPayout.processedAt ?? new Date())
            : null;

      return manager.save(foundPayout);
    });

    return this.formatPayoutForClient(payout, payment);
  }

  @Cron('*/5 * * * *')
  async reconcilePendingPayouts(): Promise<void> {
    if (this.payoutReconciliationRunning) {
      return;
    }

    this.payoutReconciliationRunning = true;
    try {
      const payouts = await this.payoutRepository.find({
        where: {
          status: In([
            DriverPayoutStatus.PENDING,
            DriverPayoutStatus.INITIATED,
          ]),
        },
        relations: ['paymentTransaction'],
        order: { requestedAt: 'ASC' },
        take: 50,
      });

      for (const payout of payouts) {
        try {
          const payment =
            payout.paymentTransaction ??
            (await this.paymentsService.findLatestTransactionForRelatedEntity(
              this.PAYOUT_RELATED_ENTITY_TYPE,
              payout.id,
              payout.driverId,
            ));
          if (!payment) {
            const requestedAt = payout.requestedAt ?? payout.createdAt;
            if (
              requestedAt &&
              Date.now() - new Date(requestedAt).getTime() >=
                this.ORPHAN_PAYOUT_GRACE_MS
            ) {
              await this.markUnsentPayoutFailed(
                payout.id,
                'Aucune transaction FlexPay creee apres reservation du retrait',
              );
            }
            continue;
          }
          if (!payment.orderNumber) {
            await this.applyPaymentToPayout(payment, payout.driverId);
            continue;
          }
          const checkedPayment = await this.paymentsService.checkPaymentStatus(
            payment.orderNumber,
            payout.driverId,
          );
          await this.applyPaymentToPayout(checkedPayment, payout.driverId);
        } catch (error) {
          this.logger.error(
            `DRIVER_PAYOUT_RECONCILIATION_FAILED payoutId=${payout.id} reason=${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } finally {
      this.payoutReconciliationRunning = false;
    }
  }

  private async reservePayout(
    driverId: string,
    amount: number,
    requestedPhone: string | undefined,
    idempotencyKey: string,
  ): Promise<DriverPayout> {
    return this.dataSource.transaction(async (manager) => {
      // Le verrou du compte conducteur serialise tous ses retraits. Deux cles
      // differentes envoyees simultanement ne peuvent donc pas depenser le
      // meme solde disponible.
      const driver = await manager.findOne(User, {
        where: { id: driverId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!driver) {
        throw new NotFoundException('Chauffeur introuvable');
      }

      const phone = requestedPhone?.trim() || driver.phone?.trim();
      if (!phone) {
        throw new BadRequestException(
          'Un numero Mobile Money est requis pour le paiement chauffeur',
        );
      }

      const existing = await manager.findOne(DriverPayout, {
        where: { driverId, idempotencyKey },
        relations: ['paymentTransaction'],
      });
      if (existing) {
        this.assertIdempotentPayoutMatches(existing, amount, phone);
        return existing;
      }

      const kycApproved = await manager.exists(KycDocument, {
        where: { userId: driverId, status: KycStatus.APPROVED },
      });
      if (!kycApproved) {
        throw new BadRequestException(
          'Votre identite KYC doit etre approuvee avant tout retrait',
        );
      }

      const availableBalance = await this.getAvailableBalanceWithManager(
        manager,
        driverId,
      );
      if (amount > availableBalance) {
        throw new BadRequestException(
          'Solde chauffeur insuffisant pour ce retrait',
        );
      }

      const payout = manager.create(DriverPayout, {
        driverId,
        idempotencyKey,
        amount,
        currency: this.getCurrency(),
        phone,
        status: DriverPayoutStatus.PENDING,
        paymentTransactionId: null,
        requestedAt: new Date(),
        processedAt: null,
        failureReason: null,
      });
      return manager.save(payout);
    });
  }

  private assertIdempotentPayoutMatches(
    payout: DriverPayout,
    amount: number,
    phone: string,
  ): void {
    if (
      this.roundMoney(Number(payout.amount)) !== amount ||
      payout.phone.trim() !== phone.trim()
    ) {
      throw new BadRequestException(
        "La cle d'idempotence a deja ete utilisee pour un autre retrait",
      );
    }
  }

  private async markUnsentPayoutFailed(
    payoutId: string,
    reason: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const payout = await manager.findOne(DriverPayout, {
        where: { id: payoutId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payout || payout.status !== DriverPayoutStatus.PENDING) {
        return;
      }
      const payment = await manager.findOne(PaymentTransaction, {
        where: {
          relatedEntityType: this.PAYOUT_RELATED_ENTITY_TYPE,
          relatedEntityId: payout.id,
          userId: payout.driverId,
        },
        order: { createdAt: 'DESC' },
      });
      if (payment) {
        return;
      }
      payout.status = DriverPayoutStatus.FAILED;
      payout.failureReason = reason.slice(0, 500);
      payout.processedAt = new Date();
      await manager.save(payout);
    });
  }

  private formatPayoutForClient(
    payout: DriverPayout,
    payment: PaymentTransaction | null = payout.paymentTransaction ?? null,
  ): DriverPayoutResponse {
    return {
      ...payout,
      amount: Number(payout.amount),
      paymentTransaction: payment,
      orderNumber: payment?.orderNumber ?? null,
      paymentMessage: payment
        ? this.paymentsService.getClientPaymentMessage(payment)
        : payout.failureReason,
    };
  }

  private logDriverPayoutResponse(
    step: string,
    payout: DriverPayout,
    payment: PaymentTransaction | null,
  ): void {
    this.logger.warn(
      `${step}: response=${this.paymentsService.formatLogPayload({
        payoutId: payout.id,
        driverId: payout.driverId,
        amount: Number(payout.amount ?? 0),
        currency: payout.currency,
        phone: payout.phone,
        payoutStatus: payout.status,
        failureReason: payout.failureReason,
        payment: this.paymentsService.formatPaymentLogResponse(payment),
      })}`,
    );
  }

  private async getAvailableBalance(driverId: string): Promise<number> {
    const earnings = await this.sumEarnings(driverId, [
      DriverEarningStatus.AVAILABLE,
    ]);
    const lockedPayouts = await this.sumPayouts(driverId, [
      DriverPayoutStatus.PENDING,
      DriverPayoutStatus.INITIATED,
      DriverPayoutStatus.SUCCEEDED,
    ]);

    return this.roundMoney(Math.max(0, earnings - lockedPayouts));
  }

  private async getAvailableBalanceWithManager(
    manager: EntityManager,
    driverId: string,
  ): Promise<number> {
    const earningResult = await manager
      .createQueryBuilder(DriverEarning, 'earning')
      .select('COALESCE(SUM(earning.netAmount), 0)', 'sum')
      .where('earning.driverId = :driverId', { driverId })
      .andWhere('earning.status = :status', {
        status: DriverEarningStatus.AVAILABLE,
      })
      .getRawOne<{ sum: string }>();
    const payoutResult = await manager
      .createQueryBuilder(DriverPayout, 'payout')
      .select('COALESCE(SUM(payout.amount), 0)', 'sum')
      .where('payout.driverId = :driverId', { driverId })
      .andWhere('payout.status IN (:...statuses)', {
        statuses: [
          DriverPayoutStatus.PENDING,
          DriverPayoutStatus.INITIATED,
          DriverPayoutStatus.SUCCEEDED,
        ],
      })
      .getRawOne<{ sum: string }>();

    const available =
      Number(earningResult?.sum ?? 0) - Number(payoutResult?.sum ?? 0);
    return this.roundMoney(Math.max(0, available));
  }

  private async sumEarnings(
    driverId: string,
    statuses: DriverEarningStatus[],
  ): Promise<number> {
    const result = await this.earningRepository
      .createQueryBuilder('earning')
      .select('COALESCE(SUM(earning.netAmount), 0)', 'sum')
      .where('earning.driverId = :driverId', { driverId })
      .andWhere('earning.status IN (:...statuses)', { statuses })
      .getRawOne<{ sum: string }>();

    return this.roundMoney(Number(result?.sum ?? 0));
  }

  private async sumPayouts(
    driverId: string,
    statuses: DriverPayoutStatus[],
  ): Promise<number> {
    const result = await this.payoutRepository
      .createQueryBuilder('payout')
      .select('COALESCE(SUM(payout.amount), 0)', 'sum')
      .where('payout.driverId = :driverId', { driverId })
      .andWhere('payout.status IN (:...statuses)', { statuses })
      .getRawOne<{ sum: string }>();

    return this.roundMoney(Number(result?.sum ?? 0));
  }

  private mapPaymentStatus(status: PaymentStatus): DriverPayoutStatus {
    switch (status) {
      case PaymentStatus.SUCCEEDED:
        return DriverPayoutStatus.SUCCEEDED;
      case PaymentStatus.FAILED:
        return DriverPayoutStatus.FAILED;
      case PaymentStatus.CANCELLED:
        return DriverPayoutStatus.CANCELLED;
      case PaymentStatus.INITIATED:
        return DriverPayoutStatus.INITIATED;
      case PaymentStatus.PENDING:
      default:
        return DriverPayoutStatus.PENDING;
    }
  }

  private getCommissionRate(): number {
    const raw =
      this.configService.get<string | number>('ZWANGA_COMMISSION_RATE') ??
      this.DEFAULT_COMMISSION_RATE;
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate < 0 || rate >= 1) {
      return this.DEFAULT_COMMISSION_RATE;
    }

    return rate;
  }

  private getCurrency(): string {
    return (
      this.configService.get<string>('TRIP_PAYMENT_CURRENCY')?.trim() ||
      this.DEFAULT_CURRENCY
    ).toUpperCase();
  }

  private getMinimumPayoutAmount(): number {
    const configured = Number(
      this.configService.get<string | number>('DRIVER_PAYOUT_MIN_AMOUNT_CDF'),
    );
    return Number.isFinite(configured) && configured > 0
      ? this.roundMoney(configured)
      : this.DEFAULT_MINIMUM_PAYOUT_AMOUNT;
  }

  private getPayoutFlexPayCallbackUrl(): string {
    const explicitUrl = this.configService
      .get<string>('FLEXPAY_DRIVER_PAYOUT_CALLBACK_URL')
      ?.trim();
    if (explicitUrl) {
      return explicitUrl;
    }

    const configuredBaseUrl =
      this.configService.get<string>('FLEXPAY_CALLBACK_BASE_URL')?.trim() ||
      this.configService.get<string>('PUBLIC_API_BASE_URL')?.trim();

    if (configuredBaseUrl) {
      return this.joinUrl(
        configuredBaseUrl,
        'driver-settlements/payouts/flexpay/callback',
      );
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
      'driver-settlements/payouts/flexpay/callback',
    );
  }

  private normalizeAmount(value: number): number {
    const amount = this.roundMoney(Number(value));
    if (!Number.isFinite(amount) || amount < 0) {
      throw new BadRequestException('Le montant est invalide');
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
