import { DRIVER_FINANCE, cashCommissionTokens } from '../driver-finance/driver-finance.policy';

const ACTIVE_BOOKING_STATUSES = new Set([
  'pending',
  'accepted',
  'completed',
  'boarding_uncertain',
]);

export interface StatementPerson {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
}

export interface StatementBookingInput {
  id: string;
  status: string;
  paymentMode: string;
  paymentStatus: string;
  numberOfSeats: number;
  paymentAmount: number | string | null;
  grossPaymentAmount: number | string | null;
  zwangaSubsidyAmount: number | string | null;
  cashCommissionPolicyVersion: number;
  cashCommissionTokenValue: number | string | null;
  passenger: StatementPerson | null;
}

export interface StatementRewardInput {
  bookingId: string;
  status: string;
  rewardAmount: number | string;
  referrer: StatementPerson | null;
}

export interface StatementEarningInput {
  bookingId: string;
  status: string;
  grossAmount: number | string;
  commissionAmount: number | string;
  netAmount: number | string;
}

export interface StatementTripInput {
  id: string;
  departureLocation: string;
  arrivalLocation: string;
  departureDate: Date | string;
  status: string;
  totalSeats: number | null;
  availableSeats: number;
  pricePerSeat: number | string;
  isFree: boolean;
  isPrivate: boolean;
  description: string | null;
  acceptedPaymentModes: string[];
  createdAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  driver: StatementPerson | null;
  vehicle: {
    brand: string;
    model: string;
    color: string;
    licensePlate: string;
    type: string;
  } | null;
}

export interface TripStatementSource {
  trip: StatementTripInput;
  bookings: StatementBookingInput[];
  referrers: Array<{ passengerId: string; referrer: StatementPerson }>;
  rewards: StatementRewardInput[];
  earnings: StatementEarningInput[];
  referralRate?: string | number | null;
}

export function resolveReferralRate(configured?: string | number | null): number {
  const rate = Number(configured ?? 0.01);
  const safe = Number.isFinite(rate) && rate > 0 && rate < 1 ? rate : 0.01;
  return Math.min(safe, DRIVER_FINANCE.commissionRate);
}

const roundMoney = (value: number) => Math.round(value * 100) / 100;
const asNumber = (value: number | string | null | undefined) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
};

export function buildTripStatement(source: TripStatementSource) {
  const commissionRate = DRIVER_FINANCE.commissionRate;
  const referralRate = resolveReferralRate(source.referralRate);
  const referrerByPassenger = new Map(
    source.referrers.map((entry) => [entry.passengerId, entry.referrer]),
  );
  const rewardByBooking = new Map(
    source.rewards.map((reward) => [reward.bookingId, reward]),
  );
  const earningByBooking = new Map(
    source.earnings.map((earning) => [earning.bookingId, earning]),
  );

  const lines = source.bookings
    .filter((booking) => ACTIVE_BOOKING_STATUSES.has(booking.status))
    .map((booking) => {
      const fare = roundMoney(
        asNumber(booking.grossPaymentAmount ?? booking.paymentAmount),
      );
      const paid = roundMoney(asNumber(booking.paymentAmount ?? fare));
      const subsidy = roundMoney(asNumber(booking.zwangaSubsidyAmount));
      const commissionBase =
        booking.cashCommissionPolicyVersion >= 1
          ? Math.max(0, Math.min(fare, paid))
          : fare;
      const commission = roundMoney(commissionBase * commissionRate);
      const mode = booking.paymentMode;
      const cash = mode === 'cash';
      const reward = rewardByBooking.get(booking.id);
      const referrer =
        reward?.referrer ??
        (booking.passenger
          ? referrerByPassenger.get(booking.passenger.id) ?? null
          : null);
      let referral = 0;
      let referralState: 'none' | 'potential' | 'recorded' | 'reversed' = 'none';
      if (reward?.status === 'reversed') {
        referralState = 'reversed';
      } else if (reward && reward.status !== 'reversed') {
        referral = roundMoney(asNumber(reward.rewardAmount));
        referralState = 'recorded';
      } else if (!cash && referrer && paid > 0) {
        referral = roundMoney(paid * referralRate);
        referralState = 'potential';
      }
      const tokenDebt = cash
        ? cashCommissionTokens(
            commissionBase,
            asNumber(booking.cashCommissionTokenValue) || 100,
            commissionRate,
          )
        : 0;
      const driver = cash
        ? roundMoney(paid + subsidy)
        : roundMoney(Math.max(0, fare - commission));
      const earning = earningByBooking.get(booking.id);
      const zwanga = roundMoney(commission - referral - subsidy);

      return {
        id: booking.id,
        status: booking.status,
        paymentMode: mode,
        paymentStatus: booking.paymentStatus,
        seats: booking.numberOfSeats,
        passenger: booking.passenger,
        fare,
        paid,
        subsidy,
        commission,
        referral,
        referralState,
        referrer: referralState === 'none' ? null : referrer,
        driver,
        zwanga,
        tokenDebt,
        currency: 'CDF',
        earning: earning
          ? {
              status: earning.status,
              netAmount: roundMoney(asNumber(earning.netAmount)),
              commissionAmount: roundMoney(asNumber(earning.commissionAmount)),
            }
          : null,
      };
    });

  const sum = (pick: (line: (typeof lines)[number]) => number) =>
    roundMoney(lines.reduce((total, line) => total + pick(line), 0));

  const booked = {
    fare: sum((line) => line.fare),
    paid: sum((line) => line.paid),
    subsidy: sum((line) => line.subsidy),
    commission: sum((line) => line.commission),
    referral: sum((line) => line.referral),
    driver: sum((line) => line.driver),
    zwanga: sum((line) => line.zwanga),
    tokenDebt: roundMoney(lines.reduce((total, line) => total + line.tokenDebt, 0)),
    seats: lines.reduce((total, line) => total + line.seats, 0),
  };

  const openSeats = Math.max(0, source.trip.availableSeats);
  const price = roundMoney(asNumber(source.trip.pricePerSeat));
  const openFare = source.trip.isFree ? 0 : roundMoney(openSeats * price);
  const openCommission = roundMoney(openFare * commissionRate);
  const openDriver = roundMoney(Math.max(0, openFare - openCommission));

  const trip = source.trip;
  return {
    trip: {
      id: trip.id,
      departureLocation: trip.departureLocation,
      arrivalLocation: trip.arrivalLocation,
      departureDate: new Date(trip.departureDate).toISOString(),
      status: trip.status,
      totalSeats: trip.totalSeats,
      availableSeats: trip.availableSeats,
      pricePerSeat: price,
      isFree: trip.isFree,
      isPrivate: trip.isPrivate,
      description: trip.description,
      acceptedPaymentModes: trip.acceptedPaymentModes ?? [],
      createdAt: new Date(trip.createdAt).toISOString(),
      startedAt: trip.startedAt ? new Date(trip.startedAt).toISOString() : null,
      completedAt: trip.completedAt
        ? new Date(trip.completedAt).toISOString()
        : null,
      driver: trip.driver,
      vehicle: trip.vehicle,
    },
    rates: {
      commissionRate,
      referralRate,
      retainedRate: roundMoney(commissionRate - referralRate),
    },
    booked,
    openSeats: {
      seats: openSeats,
      fare: openFare,
      driver: openDriver,
      zwanga: openCommission,
      note:
        openFare > 0
          ? 'Estimation si ces places se vendent au prix affiché, payées en ligne ou en jetons. En espèces, Zwanga encaisse la même commission en jetons.'
          : null,
    },
    bookings: lines,
  };
}
