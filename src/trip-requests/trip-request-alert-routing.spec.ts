import { TripRequestsService } from './trip-requests.service';

describe('request creation alert routing', () => {
  const fixture = (enabled: boolean, immediateDispatch: boolean) => {
    const dto = { immediateDispatch, departureLocation: 'Départ', arrivalLocation: 'Arrivée', vehicleType: 'car',
      maxPricePerSeat: 1000, numberOfSeats: 1,
      departureDateMin: new Date(Date.now() + (immediateDispatch ? 60_000 : 86_400_000)).toISOString(),
      departureDateMax: new Date(Date.now() + (immediateDispatch ? 600_000 : 90_000_000)).toISOString() };
    const repository = { create: jest.fn(value => ({ id: 'created', ...value })), save: jest.fn(async value => value) };
    const driverDispatch = { enabled, tick: jest.fn(), notifyScheduledRequest: jest.fn<Promise<boolean>, [string]>().mockResolvedValue(true) };
    const service = Object.assign(Object.create(TripRequestsService.prototype), {
      tripRequestRepository: repository, userRepository: { findOne: async () => ({ id: 'passenger' }) },
      driverDispatch, logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() }, ensurePassengerKycForExtraSeats: jest.fn(),
      assertRequestedVehicleSeatCapacity: jest.fn(), resolvePointFromCoordinatesOrAddress: jest.fn(),
      notifyDriversAboutTripRequest: jest.fn(), findOne: jest.fn(async () => ({ id: 'created' })),
    });
    return { dto, repository, driverDispatch, service, run: () => service.create('passenger', dto) };
  };
  it('routes immediate intent to exclusive dispatch without a broadcast', async () => {
    const f = fixture(true, true); await f.run();
    expect(f.repository.create.mock.calls[0][0].immediateDispatch).toBe(true);
    expect(f.driverDispatch.tick).toHaveBeenCalledTimes(1);
    expect(f.driverDispatch.notifyScheduledRequest).not.toHaveBeenCalled();
    expect(f.service.notifyDriversAboutTripRequest).not.toHaveBeenCalled();
  });
  it('routes scheduled departure to an alert, not an immediate offer', async () => {
    const f = fixture(true, false); await f.run();
    expect(f.repository.create.mock.calls[0][0].immediateDispatch).toBe(false);
    expect(f.driverDispatch.notifyScheduledRequest).toHaveBeenCalledWith('created');
    expect(f.driverDispatch.tick).not.toHaveBeenCalled();
    expect(f.service.notifyDriversAboutTripRequest).not.toHaveBeenCalled();
  });
  it.each([true, false])('preserves creation and legacy delivery if dispatch is disabled (intent=%s)', async immediate => {
    const f = fixture(false, immediate); await f.run();
    expect(f.repository.create.mock.calls[0][0].immediateDispatch).toBe(false);
    expect(f.service.notifyDriversAboutTripRequest).toHaveBeenCalledTimes(1);
    expect(f.driverDispatch.tick).not.toHaveBeenCalled();
    expect(f.driverDispatch.notifyScheduledRequest).not.toHaveBeenCalled();
  });
  it('keeps the date validation for an immediate intent outside the immediate window', async () => {
    const f = fixture(true, false); f.dto.immediateDispatch = true;
    await expect(f.run()).rejects.toThrow('recherche immédiate');
    expect(f.repository.save).not.toHaveBeenCalled();
  });
  it('falls back to legacy delivery when no nearby compatible driver can be alerted', async () => {
    const f = fixture(true, false); f.driverDispatch.notifyScheduledRequest.mockResolvedValue(false);
    await expect(f.run()).resolves.toEqual({ id: 'created' });
    expect(f.service.notifyDriversAboutTripRequest).toHaveBeenCalledTimes(1);
    expect(f.service.notifyDriversAboutTripRequest).toHaveBeenCalledWith(expect.objectContaining({ id: 'created', immediateDispatch: false }));
    expect(f.driverDispatch.tick).not.toHaveBeenCalled();
  });
  it('keeps legacy delivery when dispatch is not injected', async () => {
    const f = fixture(true, false); f.service.driverDispatch = undefined;
    await expect(f.run()).resolves.toEqual({ id: 'created' });
    expect(f.service.notifyDriversAboutTripRequest).toHaveBeenCalledTimes(1);
  });
  it('does not report a saved request as failed if the alert cannot be queued', async () => {
    const f = fixture(true, false); f.driverDispatch.notifyScheduledRequest.mockRejectedValue(new Error('offline'));
    await expect(f.run()).resolves.toEqual({ id: 'created' });
    expect(f.service.logger.warn).toHaveBeenCalledTimes(1);
    expect(f.service.notifyDriversAboutTripRequest).toHaveBeenCalledTimes(1);
    expect(f.driverDispatch.tick).not.toHaveBeenCalled();
  });
  it('does not report a saved request as failed even if legacy delivery also fails', async () => {
    const f = fixture(true, false); f.driverDispatch.notifyScheduledRequest.mockRejectedValue(new Error('offline'));
    f.service.userRepository.find = jest.fn().mockRejectedValue(new Error('legacy delivery unavailable'));
    f.service.notifyDriversAboutTripRequest.mockImplementation(
      TripRequestsService.prototype['notifyDriversAboutTripRequest'].bind(f.service),
    );
    await expect(f.run()).resolves.toEqual({ id: 'created' });
    expect(f.service.logger.warn).toHaveBeenCalledTimes(1);
    expect(f.service.logger.error).toHaveBeenCalledTimes(1);
  });
});
