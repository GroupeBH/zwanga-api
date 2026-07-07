import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Booking, BookingPaymentStatus } from '../bookings/entities/booking.entity';
import { PaymentMethod, PaymentPurpose, PaymentStatus, PaymentTransaction } from '../payments/entities/payment-transaction.entity';
import { FlexPayCallbackDto } from '../payments/dto/payment.dto';
import { PaymentsService } from '../payments/payments.service';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
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
}

@Injectable()
export class DriverSettlementsService {
  private readonly logger = new Logger(DriverSettlementsService.name);
  private readonly PAYOUT_RELATED_ENTITY_TYPE = 'driver_payout';
  private readonly DEFAULT_COMMISSION_RATE = 0.05;
  private readonly DEFAULT_CURRENCY = 'CDF';

  constructor(
    @InjectRepository(DriverEarning)
    private readonly earningRepository: Repository<DriverEarning>,
    @InjectRepository(DriverPayout)
    private readonly payoutRepository: Repository<DriverPayout>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly configService: ConfigService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async getSummary(driverId: string): Promise<DriverSettlementSummary> {
    const currency = this.getCurrency();
    return {
      availableBalance: await this.getAvailableBalance(driverId),
      pendingPayoutBalance: await this.sumPayouts(driverId, [
        DriverPayoutStatus.PENDING,
        DriverPayoutStatus.INITIATED,
      ]),
      paidBalance: await this.sumPayouts(driverId, [
        DriverPayoutStatus.SUCCEEDED,
      ]),
      currency,
      commissionRate: this.getCommissionRate(),
    };
  }

  async findDriverEarnings(driverId: string): Promise<DriverEarning[]> {
    return this.earningRepository.find({
      where: { driverId },
      order: { createdAt: 'DESC' },
    });
  }

  async findDriverPayouts(driverId: string): Promise<DriverPayout[]> {
    return this.payoutRepository.find({
      where: { driverId },
      relations: ['paymentTransaction'],
      order: { createdAt: 'DESC' },
    });
  }

  async recordCompletedBookingEarning(
    booking: Booking,
  ): Promise<DriverEarning | null> {
    if (![TripPaymentMode.ELECTRONIC, TripPaymentMode.POINTS].includes(booking.paymentMode)) {
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
      return existing;
    }

    const grossAmount = this.normalizeAmount(
      Number(booking.paymentAmount ?? 0),
    );
    if (grossAmount <= 0) {
      return null;
    }

    const commissionRate = this.getCommissionRate();
    const commissionAmount = this.roundMoney(grossAmount * commissionRate);
    const netAmount = this.roundMoney(grossAmount - commissionAmount);

    const earning = this.earningRepository.create({
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
    });

    const saved = await this.earningRepository.save(earning);
    this.logger.log(
      `Driver earning recorded: bookingId=${booking.id}, driverId=${booking.trip.driverId}, gross=${grossAmount}, commission=${commissionAmount}, net=${netAmount}`,
    );
    return saved;
  }

  async requestPayout(
    driverId: string,
    dto: RequestDriverPayoutDto,
  ): Promise<DriverPayout> {
    const amount = this.normalizeAmount(dto.amount);
    if (amount <= 0) {
      throw new BadRequestException('Le montant du retrait est invalide');
    }

    const availableBalance = await this.getAvailableBalance(driverId);
    if (amount > availableBalance) {
      throw new BadRequestException(
        'Solde chauffeur insuffisant pour ce retrait',
      );
    }

    const driver = await this.userRepository.findOne({
      where: { id: driverId },
    });
    if (!driver) {
      throw new NotFoundException('Chauffeur introuvable');
    }

    const phone = dto.phone?.trim() || driver.phone;
    if (!phone) {
      throw new BadRequestException(
        'Un numero Mobile Money est requis pour le paiement chauffeur',
      );
    }

    let payout = this.payoutRepository.create({
      driverId,
      amount,
      currency: this.getCurrency(),
      phone,
      status: DriverPayoutStatus.PENDING,
      paymentTransactionId: null,
      requestedAt: new Date(),
      processedAt: null,
      failureReason: null,
    });
    payout = await this.payoutRepository.save(payout);

    try {
      const payment = await this.paymentsService.initiatePayout({
        userId: driverId,
        purpose: PaymentPurpose.DRIVER_PAYOUT,
        relatedEntityType: this.PAYOUT_RELATED_ENTITY_TYPE,
        relatedEntityId: payout.id,
        phone,
        amount,
        currency: payout.currency,
        description: `Paiement chauffeur Zwanga ${payout.id}`,
        callbackUrl: this.getPayoutFlexPayCallbackUrl(),
        referencePrefix: 'DRV',
      });

      payout.paymentTransactionId = payment.id;
      payout.status = this.mapPaymentStatus(payment.status);
      payout.failureReason =
        payment.status === PaymentStatus.FAILED
          ? payment.providerMessage
          : null;
      payout.processedAt =
        payment.status === PaymentStatus.SUCCEEDED ? payment.paidAt : null;
      return this.payoutRepository.save(payout);
    } catch (error) {
      payout.status = DriverPayoutStatus.FAILED;
      payout.failureReason =
        error instanceof Error ? error.message : String(error);
      await this.payoutRepository.save(payout);
      throw error;
    }
  }

  async handlePayoutCallback(dto: FlexPayCallbackDto): Promise<DriverPayout> {
    const payment = await this.paymentsService.handleFlexPayCallback(dto);
    return this.applyPaymentToPayout(payment);
  }

  async checkPayoutStatus(
    driverId: string,
    orderNumber: string,
  ): Promise<DriverPayout> {
    const payment = await this.paymentsService.checkPaymentStatus(
      orderNumber,
      driverId,
    );
    return this.applyPaymentToPayout(payment, driverId);
  }

  private async applyPaymentToPayout(
    payment: PaymentTransaction,
    driverId?: string,
  ): Promise<DriverPayout> {
    if (
      payment.purpose !== PaymentPurpose.DRIVER_PAYOUT ||
      payment.relatedEntityType !== this.PAYOUT_RELATED_ENTITY_TYPE
    ) {
      throw new BadRequestException(
        'Cette transaction ne correspond pas a un paiement chauffeur',
      );
    }

    const payout = await this.payoutRepository.findOne({
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
    });
    if (!payout) {
      throw new NotFoundException('Paiement chauffeur introuvable');
    }

    payout.paymentTransactionId = payment.id;
    payout.status = this.mapPaymentStatus(payment.status);
    payout.failureReason =
      payment.status === PaymentStatus.FAILED
        ? payment.providerMessage
        : payout.failureReason;
    payout.processedAt =
      payment.status === PaymentStatus.SUCCEEDED
        ? payment.paidAt ?? new Date()
        : payout.processedAt;

    return this.payoutRepository.save(payout);
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
