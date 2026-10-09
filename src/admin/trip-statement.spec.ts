import { buildTripStatement, resolveReferralRate } from './trip-statement';

const trip = {
  id: 'trip-1',
  departureLocation: 'Gombe',
  arrivalLocation: 'Limete',
  departureDate: '2026-10-08T08:00:00.000Z',
  status: 'upcoming',
  totalSeats: 3,
  availableSeats: 1,
  pricePerSeat: 5000,
  isFree: false,
  isPrivate: false,
  description: 'Départ matinal',
  acceptedPaymentModes: ['electronic', 'cash', 'points'],
  createdAt: '2026-10-07T08:00:00.000Z',
  startedAt: null,
  completedAt: null,
  driver: { id: 'driver-1', firstName: 'Aline', lastName: 'Kabila', phone: '+243800000000' },
  vehicle: {
    brand: 'Toyota',
    model: 'Vitz',
    color: 'blanc',
    licensePlate: 'KN1234',
    type: 'car',
  },
};

const passenger = {
  id: 'passenger-1',
  firstName: 'Paul',
  lastName: 'Ilunga',
  phone: '+243810000000',
};

describe('buildTripStatement', () => {
  it('splits an electronic fare between the driver, Zwanga and the referrer', () => {
    const statement = buildTripStatement({
      trip,
      referralRate: 0.01,
      bookings: [
        {
          id: 'booking-1',
          status: 'accepted',
          paymentMode: 'electronic',
          paymentStatus: 'succeeded',
          numberOfSeats: 2,
          paymentAmount: 10000,
          grossPaymentAmount: 10000,
          zwangaSubsidyAmount: 0,
          cashCommissionPolicyVersion: 2,
          cashCommissionTokenValue: 100,
          passenger,
        },
      ],
      referrers: [
        {
          passengerId: passenger.id,
          referrer: { id: 'ref-1', firstName: 'Mado', lastName: 'Tshika', phone: null },
        },
      ],
      rewards: [],
      earnings: [],
    });

    expect(statement.bookings[0]).toMatchObject({
      commission: 500,
      referral: 100,
      referralState: 'potential',
      driver: 9500,
      zwanga: 400,
      tokenDebt: 0,
    });
    expect(statement.booked.zwanga).toBe(400);
    expect(statement.openSeats).toMatchObject({ seats: 1, fare: 5000, zwanga: 250, driver: 4750 });
  });

  it('counts the subsidy as a Zwanga cost and keeps a recorded referral amount', () => {
    const statement = buildTripStatement({
      trip,
      bookings: [
        {
          id: 'booking-1',
          status: 'completed',
          paymentMode: 'electronic',
          paymentStatus: 'succeeded',
          numberOfSeats: 1,
          paymentAmount: 8000,
          grossPaymentAmount: 10000,
          zwangaSubsidyAmount: 2000,
          cashCommissionPolicyVersion: 2,
          cashCommissionTokenValue: 100,
          passenger,
        },
      ],
      referrers: [],
      rewards: [
        {
          bookingId: 'booking-1',
          status: 'pending',
          rewardAmount: 80,
          referrer: { id: 'ref-1', firstName: 'Mado', lastName: 'Tshika', phone: null },
        },
      ],
      earnings: [],
    });

    expect(statement.bookings[0]).toMatchObject({
      commission: 400,
      referral: 80,
      referralState: 'recorded',
      driver: 9600,
      subsidy: 2000,
      zwanga: -1680,
    });
  });

  it('keeps cash with the driver and records Zwanga commission as a token debt', () => {
    const statement = buildTripStatement({
      trip,
      bookings: [
        {
          id: 'booking-1',
          status: 'accepted',
          paymentMode: 'cash',
          paymentStatus: 'not_required',
          numberOfSeats: 1,
          paymentAmount: 10000,
          grossPaymentAmount: 10000,
          zwangaSubsidyAmount: 0,
          cashCommissionPolicyVersion: 2,
          cashCommissionTokenValue: 100,
          passenger,
        },
      ],
      referrers: [
        {
          passengerId: passenger.id,
          referrer: { id: 'ref-1', firstName: 'Mado', lastName: 'Tshika', phone: null },
        },
      ],
      rewards: [],
      earnings: [],
    });

    expect(statement.bookings[0]).toMatchObject({
      driver: 10000,
      referral: 0,
      referralState: 'none',
      commission: 500,
      tokenDebt: 5,
      zwanga: 500,
    });
  });

  it('ignores cancelled bookings and a reversed referral', () => {
    const statement = buildTripStatement({
      trip: { ...trip, availableSeats: 0, isFree: true },
      bookings: [
        {
          id: 'gone',
          status: 'cancelled',
          paymentMode: 'electronic',
          paymentStatus: 'cancelled',
          numberOfSeats: 1,
          paymentAmount: 5000,
          grossPaymentAmount: 5000,
          zwangaSubsidyAmount: 0,
          cashCommissionPolicyVersion: 2,
          cashCommissionTokenValue: 100,
          passenger,
        },
      ],
      referrers: [],
      rewards: [],
      earnings: [],
    });

    expect(statement.bookings).toEqual([]);
    expect(statement.booked.zwanga).toBe(0);
    expect(statement.openSeats.fare).toBe(0);
  });

  it('caps the referral rate at the platform commission', () => {
    expect(resolveReferralRate(0.2)).toBe(0.05);
    expect(resolveReferralRate(undefined)).toBe(0.01);
  });
});
