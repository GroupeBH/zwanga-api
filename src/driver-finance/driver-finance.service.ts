import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WalletService } from '../wallet/wallet.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { Trip } from '../trips/entities/trip.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import {
  WalletAccount,
  WalletAccountType,
} from '../wallet/entities/wallet-account.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import {
  cashCommissionTokens,
  DRIVER_FINANCE,
  normalizeAcceptedPaymentModes,
} from './driver-finance.policy';

@Injectable()
export class DriverFinanceService {
  constructor(
    private readonly db: DataSource,
    private readonly wallet: WalletService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  private async reserveState(userId: string) {
    const account = await this.db
      .getRepository(WalletAccount)
      .findOneBy({ userId, type: WalletAccountType.POINTS });
    const [row] = await this.db.query<{ debt: string; enabled: boolean }[]>(
      'SELECT COALESCE(SUM("debtTokens"),0) AS debt, zwanga_cash_policy_enabled() AS enabled FROM cash_commissions WHERE "driverId" = $1 AND "debtTokens" > 0',
      [userId],
    );
    const reservedTokens = Number(account?.reservedCashCommissionBalance ?? 0);
    const debtTokens = Number(row?.debt ?? 0);
    return {
      policyActive: row?.enabled !== false,
      availableTokens: Math.max(
        0,
        Math.round((Number(account?.balance ?? 0) - reservedTokens) * 100) /
          100,
      ),
      reservedTokens,
      debtTokens,
      remainingCreditTokens: Math.max(
        0,
        Math.round((DRIVER_FINANCE.cashDebtLimitTokens - debtTokens) * 100) /
          100,
      ),
      blocked: Boolean(account?.withdrawalsBlocked),
      moneyPerToken: 100,
      debtLimitTokens: DRIVER_FINANCE.cashDebtLimitTokens,
    };
  }

  async summary(userId: string) {
    const [cash, pro, trials, recentCommissions] = await Promise.all([
      this.reserveState(userId),
      this.subscriptions.getPremiumOverview(userId),
      this.db.query<{ startDate: Date; endDate: Date }[]>(
        'SELECT "startDate","endDate" FROM driver_pro_trial_claims WHERE "userId" = $1',
        [userId],
      ),
      this.db.query<Record<string, unknown>[]>(
        'SELECT * FROM cash_commissions WHERE "driverId" = $1 ORDER BY "updatedAt" DESC, "bookingId" LIMIT 20',
        [userId],
      ),
    ]);
    return {
      ...DRIVER_FINANCE,
      pro,
      trial: trials[0] ?? null,
      cash: {
        ...cash,
        enabled:
          !cash.blocked &&
          cash.debtTokens <= cash.debtLimitTokens &&
          cash.availableTokens + cash.remainingCreditTokens > 0,
        availableCreditTokens: !cash.blocked ? cash.remainingCreditTokens : 0,
        debtAmount:
          Math.round(cash.debtTokens * cash.moneyPerToken * 100) / 100,
        coverageAmount: Math.floor(
          (cash.availableTokens * cash.moneyPerToken) /
            DRIVER_FINANCE.commissionRate,
        ),
        purchasedTokensOnly: false,
      },
      recentCommissions,
    };
  }

  private async options(trip: Trip, amount: number, booking?: Booking) {
    const accepted = normalizeAcceptedPaymentModes(trip.acceptedPaymentModes);
    const state = await this.reserveState(trip.driverId);
    const tokens = cashCommissionTokens(amount, state.moneyPerToken);
    const credit =
      booking && booking.cashCommissionPolicyVersion < 2
        ? 0
        : state.remainingCreditTokens;
    const alreadyAcceptedCash =
      booking?.paymentMode === TripPaymentMode.CASH &&
      ['accepted', 'completed'].includes(booking.status);
    const cashAvailable =
      amount <= 0 ||
      alreadyAcceptedCash ||
      (!state.blocked &&
        state.debtTokens <= state.debtLimitTokens &&
        state.availableTokens + credit >= tokens);
    return {
      acceptedPaymentModes: accepted,
      availablePaymentModes: accepted.filter(
        (mode) => mode !== TripPaymentMode.CASH || cashAvailable,
      ),
      cashUnavailableReason:
        cashAvailable || !accepted.includes(TripPaymentMode.CASH)
          ? null
          : 'La commission dépasserait la réserve disponible ou le plafond cumulé de 25 jetons de dette du conducteur. Choisissez un autre mode ou réessayez après sa recharge.',
      commissionRate: DRIVER_FINANCE.commissionRate,
    };
  }

  async tripOptions(userId: string, tripId: string, seats = 1) {
    if (!Number.isInteger(seats) || seats < 1 || seats > 100)
      throw new BadRequestException('Nombre de places invalide.');
    const trip = await this.db.getRepository(Trip).findOneBy({ id: tripId });
    if (!trip) throw new NotFoundException('Trajet introuvable.');
    if (
      trip.isPrivate &&
      trip.driverId !== userId &&
      !(await this.db
        .getRepository(Booking)
        .existsBy({ tripId, passengerId: userId }))
    ) {
      throw new ForbiddenException('Trajet privé.');
    }
    return this.options(trip, Math.max(0, Number(trip.pricePerSeat) * seats));
  }

  async bookingOptions(userId: string, bookingId: string) {
    const booking = await this.db
      .getRepository(Booking)
      .findOne({ where: { id: bookingId }, relations: ['trip'] });
    if (!booking) throw new NotFoundException('Réservation introuvable.');
    if (booking.passengerId !== userId && booking.trip.driverId !== userId)
      throw new ForbiddenException();
    const result = await this.options(
      booking.trip,
      Number(booking.paymentAmount),
      booking,
    );
    // Later trip edits do not invalidate a payment mode already accepted for this booking.
    if (
      booking.status !== BookingStatus.PENDING &&
      !result.availablePaymentModes.includes(booking.paymentMode)
    ) {
      result.availablePaymentModes.push(booking.paymentMode);
    }
    return result;
  }
}
