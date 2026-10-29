import { TripRequestsService } from './trip-requests.service';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';
import { VehicleType } from '../vehicles/entities/vehicle.entity';
import { enqueueTransactionalNotification } from '../notifications/transactional-notification';

jest.mock('../notifications/transactional-notification', () => ({ enqueueTransactionalNotification: jest.fn() }));

describe('scheduled request acceptance durable passenger response', () => {
  const fixture = () => {
    const request: any = { id: 'request-test', passengerId: 'passenger-test',
      status: TripRequestStatus.PENDING, departureDateMin: new Date(Date.now() + 30_000),
      departureDateMax: new Date(Date.now() + 90_000), maxPricePerSeat: 2500,
      numberOfSeats: 1, vehicleType: VehicleType.CAR, paymentMode: 'cash' };
    const locked: any = { ...request };
    const save = jest.fn(async value => value); const update = jest.fn();
    const query = jest.fn(async (sql: string) => sql.includes('ST_DWithin') ? [{ allowed: 1 }] : []);
    const manager = { query, getRepository: (entity: unknown) => entity === TripRequest
      ? { findOne: jest.fn(async () => locked), save } : { update } };
    const transaction = jest.fn(async work => work(manager));
    const sendNotification = jest.fn();
    const service: any = Object.assign(Object.create(TripRequestsService.prototype), {
      logger: { log() {}, warn() {} }, expireRequests: jest.fn(), findOne: jest.fn(async () => request),
      tripRequestRepository: { findOne: jest.fn(async () => request), manager: {
        query, getRepository: () => ({ exists: jest.fn(async () => false) }), transaction } },
      userRepository: { findOne: jest.fn(async () => ({ id: 'driver-test' })) },
      vehicleRepository: { findOne: jest.fn(async () => ({ id: 'vehicle-test', type: VehicleType.CAR,
        ownerId: 'driver-test', isActive: true, seats: 4 })) },
      tripsService: { create: jest.fn(async () => ({ id: 'trip-test' })) },
      bookingsService: { create: jest.fn(), findAllByTrip: jest.fn(async () => [
        { id: 'booking-test', passengerId: 'passenger-test' }]), acceptBooking: jest.fn() },
      notificationService: { sendNotification },
    });
    return { service, locked, manager, transaction, save, sendNotification };
  };
  beforeEach(() => jest.clearAllMocks());
  it('commits the selection and response in the same transaction even without a passenger push token', async () => {
    const f = fixture();
    await f.service.acceptTripRequest('driver-test', 'request-test', {});
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ selectedDriverId: 'driver-test', tripId: 'trip-test' }));
    expect(enqueueTransactionalNotification).toHaveBeenCalledWith(f.manager, expect.objectContaining({
      eventKey: 'request-accepted:request-test:trip-test', userId: 'passenger-test',
      data: expect.objectContaining({ type: 'trip_request_accepted', selectedAt: expect.any(String) }),
    }));
    expect(f.sendNotification).not.toHaveBeenCalled();
  });
  it('does not enqueue a response when cancellation won the final request lock', async () => {
    const f = fixture(); f.locked.status = TripRequestStatus.CANCELLED;
    await expect(f.service.acceptTripRequest('driver-test', 'request-test', {})).rejects.toThrow('commande');
    expect(f.save).not.toHaveBeenCalled();
    expect(enqueueTransactionalNotification).not.toHaveBeenCalled();
  });
});
