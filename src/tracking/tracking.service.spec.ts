import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { TripShareLink } from './entities/trip-share-link.entity';
import { TrackingService } from './tracking.service';

const makeRepository = () => ({
  create: jest.fn((value) => value),
  exist: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
});

describe('TrackingService', () => {
  let service: TrackingService;
  let tripShareLinkRepository: ReturnType<typeof makeRepository>;
  let tripRepository: ReturnType<typeof makeRepository>;
  let bookingRepository: ReturnType<typeof makeRepository>;

  const driverId = '11111111-1111-1111-1111-111111111111';
  const passengerId = '22222222-2222-2222-2222-222222222222';
  const tripId = '33333333-3333-3333-3333-333333333333';
  const bookingId = '44444444-4444-4444-4444-444444444444';

  const trip = {
    id: tripId,
    driverId,
    status: TripStatus.ACTIVE,
    departureLocation: 'Gombe',
    departureReference: null,
    departurePoint: { type: 'Point', coordinates: [15.31, -4.32] },
    arrivalLocation: 'Aeroport',
    arrivalReference: null,
    arrivalPoint: { type: 'Point', coordinates: [15.44, -4.38] },
    departureDate: new Date('2026-07-07T09:00:00.000Z'),
    startedAt: new Date('2026-07-07T09:10:00.000Z'),
    estimatedArrivalDate: null,
    completedAt: null,
    currentLocation: { type: 'Point', coordinates: [15.35, -4.34] },
    lastLocationUpdateAt: new Date('2026-07-07T09:25:00.000Z'),
    driver: { firstName: 'Jean', lastName: 'Mav' },
    vehicle: {
      brand: 'Toyota',
      model: 'Noah',
      color: 'Noir',
      licensePlate: '1234AB',
    },
  } as unknown as Trip;

  const booking = {
    id: bookingId,
    tripId,
    passengerId,
    status: BookingStatus.ACCEPTED,
    pickedUp: false,
    pickedUpAt: null,
    pickedUpConfirmedByPassenger: false,
    droppedOff: false,
    droppedOffAt: null,
    droppedOffConfirmedByPassenger: false,
    passengerOrigin: 'Victoire',
    passengerOriginReference: null,
    passengerOriginPoint: { type: 'Point', coordinates: [15.3, -4.33] },
    passengerDestination: 'Ndjili',
    passengerDestinationReference: null,
    passengerDestinationPoint: { type: 'Point', coordinates: [15.45, -4.38] },
    passenger: { firstName: 'Aline', lastName: 'K' },
  } as unknown as Booking;

  beforeEach(async () => {
    tripShareLinkRepository = makeRepository();
    tripRepository = makeRepository();
    bookingRepository = makeRepository();

    const moduleRef = await Test.createTestingModule({
      providers: [
        TrackingService,
        {
          provide: getRepositoryToken(TripShareLink),
          useValue: tripShareLinkRepository,
        },
        { provide: getRepositoryToken(Trip), useValue: tripRepository },
        { provide: getRepositoryToken(Booking), useValue: bookingRepository },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'TRACKING_PUBLIC_BASE_URL'
                ? 'https://zwanga-app.com'
                : undefined,
            ),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(TrackingService);
  });

  it('creates a public tracking link for an accepted passenger booking', async () => {
    tripRepository.findOne.mockResolvedValue(trip);
    bookingRepository.findOne.mockResolvedValue(booking);
    tripShareLinkRepository.exist.mockResolvedValue(false);
    tripShareLinkRepository.save.mockImplementation(async (value) => ({
      id: 'share-id',
      ...value,
    }));

    const result = await service.createTripShareLink(passengerId, tripId, {
      bookingId,
      recipientEmail: 'proche@example.com',
    });

    expect(result.publicUrl).toContain('https://zwanga-app.com/track/');
    expect(result.bookingId).toBe(bookingId);
    expect(result.email.mailtoUrl).toContain('mailto:proche%40example.com');
    expect(tripShareLinkRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        tripId,
        bookingId,
        ownerId: passengerId,
      }),
    );
  });

  it('refuses link creation when the user is not driver or accepted passenger', async () => {
    tripRepository.findOne.mockResolvedValue(trip);
    bookingRepository.findOne.mockResolvedValue(null);

    await expect(
      service.createTripShareLink(
        '55555555-5555-5555-5555-555555555555',
        tripId,
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns public tracking data for a valid token', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    tripShareLinkRepository.findOne.mockResolvedValue({
      id: 'share-id',
      token: 'public-token',
      recipientName: 'Aline',
      expiresAt,
      revokedAt: null,
      trip,
      booking,
    });

    const result = await service.getPublicTripTracking('public-token');

    expect(result.trip.currentLocation).toEqual({
      latitude: -4.34,
      longitude: 15.35,
    });
    expect(result.booking?.origin.coordinates).toEqual({
      latitude: -4.33,
      longitude: 15.3,
    });
    expect(tripShareLinkRepository.update).toHaveBeenCalledWith('share-id', {
      lastAccessedAt: expect.any(Date),
    });
  });
});
