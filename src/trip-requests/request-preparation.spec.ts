import { TripRequestsService } from './trip-requests.service';
import { VehicleType } from '../vehicles/entities/vehicle.entity';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

describe('parallel request preparation before dispatch (no external calls)', () => {
  const fixture = () => {
    const repository = {
      create: jest.fn(value => value),
      save: jest.fn(async value => ({ id: 'request', ...value })),
    };
    const weather = { getRouteImpact: jest.fn().mockResolvedValue({ priceMultiplier: 1.3 }) };
    const dispatch = { enabled: true, notifyScheduledRequest: jest.fn().mockResolvedValue(undefined) };
    const service = new TripRequestsService(
      repository as any, {} as any, { findOne: async () => ({ id: 'passenger' }) } as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      weather as any, {} as any, dispatch as any,
    );
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'request' } as any);
    const points = jest.spyOn(service as any, 'resolvePointFromCoordinatesOrAddress');
    const route = jest.spyOn(service as any, 'calculateRouteDistanceMeters').mockResolvedValue(5000);
    const dto = {
      departureLocation: 'Gombe', arrivalLocation: 'Limete', vehicleType: VehicleType.CAR,
      departureDateMin: new Date(Date.now() + 60_000).toISOString(),
      departureDateMax: new Date(Date.now() + 30 * 60_000).toISOString(), immediateDispatch: true,
    };
    return { service, repository, weather, dispatch, points, route, dto };
  };
  const departure = { type: 'Point', coordinates: [15.3, -4.3] };
  const arrival = { type: 'Point', coordinates: [15.4, -4.4] };
  afterEach(() => jest.restoreAllMocks());

  it('starts both geocodings together and only publishes after both points and persistence', async () => {
    const f = fixture(); const a = deferred<any>(), b = deferred<any>();
    f.points.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const creating = f.service.create('passenger', { ...f.dto, maxPricePerSeat: 2000 });
    // Yield the user lookup, without resolving either geocoding operation.
    await Promise.resolve(); await Promise.resolve();
    expect(f.points).toHaveBeenCalledTimes(2);
    expect(f.repository.save).not.toHaveBeenCalled();
    expect(f.dispatch.notifyScheduledRequest).not.toHaveBeenCalled();
    a.resolve(departure); await Promise.resolve();
    expect(f.repository.save).not.toHaveBeenCalled();
    b.resolve(arrival); await creating;
    expect(f.repository.create).toHaveBeenCalledWith(expect.objectContaining({
      departurePoint: departure, arrivalPoint: arrival, maxPricePerSeat: 2000,
    }));
    expect(f.dispatch.notifyScheduledRequest).toHaveBeenCalledWith('request', true);
    expect(f.repository.save.mock.invocationCallOrder[0]).toBeLessThan(f.dispatch.notifyScheduledRequest.mock.invocationCallOrder[0]);
    expect(f.route).not.toHaveBeenCalled();
    expect(f.weather.getRouteImpact).not.toHaveBeenCalled();
  });

  it('starts route and weather together while preserving the recommended amount', async () => {
    const f = fixture(); const route = deferred<number>(), weather = deferred<any>();
    f.route.mockReturnValue(route.promise); f.weather.getRouteImpact.mockReturnValue(weather.promise);
    const price = (f.service as any).calculateRecommendedPricePerSeat(departure, arrival, VehicleType.CAR, 'test');
    expect(f.route).toHaveBeenCalledTimes(1);
    expect(f.weather.getRouteImpact).toHaveBeenCalledWith(departure.coordinates, arrival.coordinates);
    route.resolve(5000); weather.resolve({ priceMultiplier: 1.3 });
    await expect(price).resolves.toBe(3250);
  });

  it('does not create or alert on a geocoding failure, even if the other operation completes later', async () => {
    const f = fixture(); const a = deferred<any>(), b = deferred<any>();
    f.points.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const failure = expect(f.service.create('passenger', f.dto)).rejects.toThrow('synthetic geocoding error');
    a.reject(new Error('synthetic geocoding error')); await failure;
    b.resolve(arrival); await Promise.resolve();
    expect(f.repository.save).not.toHaveBeenCalled();
    expect(f.dispatch.notifyScheduledRequest).not.toHaveBeenCalled();
  });

  it('never alerts if storing the request fails', async () => {
    const f = fixture(); f.points.mockResolvedValueOnce(departure).mockResolvedValueOnce(arrival);
    f.repository.save.mockRejectedValueOnce(new Error('synthetic database failure'));
    await expect(f.service.create('passenger', f.dto)).rejects.toThrow('synthetic database failure');
    expect(f.dispatch.notifyScheduledRequest).not.toHaveBeenCalled();
  });
});
