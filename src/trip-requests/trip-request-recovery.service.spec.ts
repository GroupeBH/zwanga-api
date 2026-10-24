import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { DriverOffer, DriverOfferStatus } from './entities/driver-offer.entity';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';
import { TripRequestRecoveryService } from './trip-request-recovery.service';

describe('TripRequestRecoveryService', () => {
  let manager: { findOne: jest.Mock; update: jest.Mock; exists: jest.Mock };
  let tripRequestRepository: { manager: { transaction: jest.Mock } };
  let notificationService: {
    sendNotificationToUser: jest.Mock;
    sendToMultiple: jest.Mock;
  };
  let service: TripRequestRecoveryService;

  beforeEach(() => {
    manager = { findOne: jest.fn(), update: jest.fn(), exists: jest.fn().mockResolvedValue(false) };
    tripRequestRepository = {
      manager: {
        transaction: jest.fn(
          (callback: (transactionManager: typeof manager) => unknown) =>
            callback(manager),
        ),
      },
    };
    notificationService = {
      sendNotificationToUser: jest.fn().mockResolvedValue(true),
      sendToMultiple: jest.fn().mockResolvedValue(true),
    };
    service = new TripRequestRecoveryService(
      tripRequestRepository as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      notificationService as any,
    );
  });

  it('atomically republishes the request when its passenger releases the overdue driver', async () => {
    const selectedRequest = {
      id: 'request-1',
      tripId: null,
      passengerId: 'passenger-1',
      selectedDriverId: 'driver-1',
      status: TripRequestStatus.DRIVER_SELECTED,
      departureLocation: 'Gombe',
      arrivalLocation: 'Limete',
      departureDateMin: new Date('2026-09-09T08:00:00.000Z'),
      departureDateMax: new Date('2026-09-09T09:00:00.000Z'),
      numberOfSeats: 1,
      maxPricePerSeat: 5000,
      vehicleType: 'car',
    } as TripRequest;
    const reopenedRequest = {
      ...selectedRequest,
      selectedDriverId: null,
      status: TripRequestStatus.PENDING,
    } as TripRequest;
    manager.findOne
      .mockResolvedValueOnce(selectedRequest)
      .mockResolvedValueOnce(reopenedRequest);
    manager.update
      .mockResolvedValueOnce({ affected: 1 })
      .mockResolvedValueOnce({ affected: 1 });

    await expect(
      service.reopenAfterPassengerReleasesOverdueDriver(
        selectedRequest.id,
        selectedRequest.passengerId,
      ),
    ).resolves.toBe(reopenedRequest);

    expect(manager.update).toHaveBeenNthCalledWith(
      1,
      TripRequest,
      expect.objectContaining({
        id: selectedRequest.id,
        tripId: expect.objectContaining({ _type: 'isNull' }),
        selectedDriverId: selectedRequest.selectedDriverId,
        status: TripRequestStatus.DRIVER_SELECTED,
      }),
      {
        status: TripRequestStatus.PENDING,
        departureDateMin: expect.any(Date),
        departureDateMax: expect.any(Date),
        dispatchCheckedAt: null,
        selectedDriverId: null,
        selectedVehicleId: null,
        selectedPricePerSeat: null,
        selectedDriverRequiresPassengerKyc: false,
        selectedAt: null,
        tripId: null,
        expirationNotificationSent: false,
        driverPickupOverdueNotifiedAt: null,
      },
    );
    expect(manager.update).toHaveBeenNthCalledWith(
      2,
      DriverOffer,
      {
        tripRequestId: selectedRequest.id,
        driverId: selectedRequest.selectedDriverId,
        status: DriverOfferStatus.ACCEPTED,
      },
      { status: DriverOfferStatus.CANCELLED },
    );
    expect(notificationService.sendNotificationToUser).toHaveBeenCalledWith(
      selectedRequest.passengerId,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        type: 'trip_request_reopened',
        tripRequestId: selectedRequest.id,
      }),
    );
  });

  it('cancels and detaches the old private trip while reopening its request', async () => {
    const selectedRequest = {
      id: 'request-2',
      tripId: 'trip-2',
      passengerId: 'passenger-2',
      selectedDriverId: 'driver-2',
      status: TripRequestStatus.DRIVER_SELECTED,
      departureLocation: 'Gombe',
      arrivalLocation: 'Limete',
      departureDateMin: new Date('2026-09-09T08:00:00.000Z'),
      departureDateMax: new Date('2026-09-09T09:00:00.000Z'),
      numberOfSeats: 1,
      maxPricePerSeat: 5000,
      vehicleType: 'car',
    } as TripRequest;
    const linkedTrip = {
      id: selectedRequest.tripId,
      tripRequestId: selectedRequest.id,
      isPrivate: true,
      status: TripStatus.PENDING,
    } as Trip;
    const reopenedRequest = {
      ...selectedRequest,
      tripId: null,
      selectedDriverId: null,
      status: TripRequestStatus.PENDING,
    } as TripRequest;
    manager.findOne
      .mockResolvedValueOnce(selectedRequest)
      .mockResolvedValueOnce(linkedTrip)
      .mockResolvedValueOnce(reopenedRequest);
    manager.update.mockResolvedValue({ affected: 1 });

    await service.reopenAfterPassengerReleasesOverdueDriver(
      selectedRequest.id,
      selectedRequest.passengerId,
    );

    expect(manager.update).toHaveBeenCalledWith(
      Trip,
      { id: linkedTrip.id, tripRequestId: selectedRequest.id },
      { tripRequestId: null, status: TripStatus.CANCELLED },
    );
  });

  it('does nothing when the passenger no longer owns that selected request state', async () => {
    manager.findOne.mockResolvedValue(null);

    await expect(
      service.reopenAfterPassengerReleasesOverdueDriver(
        'request-3',
        'passenger-3',
      ),
    ).resolves.toBeNull();

    expect(manager.update).not.toHaveBeenCalled();
    expect(notificationService.sendNotificationToUser).not.toHaveBeenCalled();
  });

  it.each([true, false])('renews the window only when searching now (%s)', async searchNow => {
    const row = { id: 'request', passengerId: 'passenger', tripId: null,
      selectedDriverId: 'driver', immediateDispatch: true, status: TripRequestStatus.DRIVER_SELECTED,
      departureDateMin: new Date(Date.now() - 3_600_000), departureDateMax: new Date(Date.now() - 60_000) };
    const originalMax = row.departureDateMax;
    manager.findOne.mockImplementation(async () => ({ ...row }));
    manager.update.mockImplementation(async (entity, _where, patch) => {
      if (entity === TripRequest) Object.assign(row, patch);
      return { affected: 1 };
    });
    const result = await service.reopenAfterPassengerReleasesOverdueDriver('request', 'passenger', searchNow);
    if (searchNow) {
      expect(result?.status).toBe(TripRequestStatus.PENDING);
      expect(result!.departureDateMax.getTime()).toBeGreaterThan(Date.now());
      expect(result!.departureDateMax.getTime() - result!.departureDateMin.getTime()).toBe(30 * 60_000);
      expect(notificationService.sendNotificationToUser).toHaveBeenCalled();
    } else {
      expect(result?.status).toBe(TripRequestStatus.EXPIRED);
      expect(result?.departureDateMax).toEqual(originalMax);
      expect(notificationService.sendNotificationToUser).not.toHaveBeenCalled();
    }
    expect(notificationService.sendToMultiple).not.toHaveBeenCalled();
  });

  it('keeps the existing ride running when the original passenger releases the driver but other passengers remain', async () => {
    const request = { id: 'request', passengerId: 'passenger', selectedDriverId: 'driver',
      tripId: 'trip', status: TripRequestStatus.DRIVER_SELECTED };
    manager.findOne.mockResolvedValueOnce(request).mockResolvedValueOnce({
      id: 'trip', tripRequestId: 'request', isPrivate: true, status: TripStatus.ACTIVE,
    }).mockResolvedValueOnce({ ...request, selectedDriverId: null, status: TripRequestStatus.PENDING });
    manager.update.mockResolvedValue({ affected: 1 });
    manager.exists.mockResolvedValue(true);
    await service.reopenAfterPassengerReleasesOverdueDriver('request', 'passenger');
    expect(manager.update).toHaveBeenCalledWith(Trip, { id: 'trip', tripRequestId: 'request' }, { tripRequestId: null });
  });
});
