import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { TripRequest, TripRequestStatus } from '../src/trip-requests/entities/trip-request.entity';
import { homeRequestIds, HOME_REQUEST_LIMIT } from '../src/trip-requests/home-request-ids';
import { recordRequestRefusal } from '../src/trip-requests/request-refusal';
import type { TripRequestsService } from '../src/trip-requests/trip-requests.service';
import type { User } from '../src/users/entities/user.entity';
import { VehicleType } from '../src/vehicles/entities/vehicle.entity';

type Fixture = { source: DataSource; browsing: () => TripRequestsService;
  driver: () => Promise<{ user: User }>; request: () => Promise<TripRequest> };

/** Existing disposable PostGIS fixture; no application data or notification send. */
export function homeDiscoveryPostgresTests(fixture: () => Fixture) {
  it('Home discovery limits hydration to the nearest ten, not the ten newest', async () => {
    const { source, driver, request, browsing } = fixture();
    const d = await driver(), seed = await request(), repo = source.getRepository(TripRequest);
    const rows = await repo.save(Array.from({ length: 25 }, (_, index) => ({ ...seed,
      id: randomUUID(), createdAt: new Date(Date.now() - (index + 1) * 10000),
      departurePoint: { type: 'Point' as const, coordinates: [15.31 + (25 - index) * 0.001, -4.3] },
    })));
    await repo.delete(seed.id);
    const nearest = [...rows].reverse().slice(0, HOME_REQUEST_LIMIT).map(row => row.id);
    expect(await homeRequestIds(repo, d.user.id)).toEqual(nearest);
    const service = browsing();
    const hydrate = jest.spyOn(service['tripRequestRepository'], 'find');
    const found = await service.findAll(d.user.id, true);
    expect(found.map(row => row.id)).toEqual(nearest);
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(hydrate.mock.calls[0][0]?.where).toMatchObject({ id: { objectLiteralParameters: { homeRequestIds: nearest } } });
    // Scope is opt-in: the existing full discovery endpoint is unchanged.
    expect(await service.findAll(d.user.id)).toHaveLength(25);
  });

  it('Home discovery preserves refusals, targeting, types, ownership and deadline protections', async () => {
    const { source, driver, request, browsing } = fixture();
    const d = await driver(), other = await driver(), seed = await request(), repo = source.getRepository(TripRequest);
    const copy = (change: Partial<TripRequest>) => repo.save({ ...seed, id: randomUUID(), ...change });
    await copy({ passengerId: d.user.id });
    await copy({ targetDriverId: other.user.id });
    await copy({ selectedDriverId: other.user.id });
    await copy({ status: TripRequestStatus.CANCELLED });
    await copy({ departureDateMax: new Date(Date.now() - 4 * 3600000) });
    await copy({ vehicleType: VehicleType.MOTORCYCLE_TWO_WHEELS, vehicleTypes: [VehicleType.MOTORCYCLE_TWO_WHEELS] });
    await copy({ departurePoint: { type: 'Point', coordinates: [25.2, 0.52] } });
    const refused = await copy({});
    await recordRequestRefusal(source.manager, d.user.id, refused.id);
    await repo.update(seed.id, { vehicleTypes: [VehicleType.MOTORCYCLE_TWO_WHEELS, VehicleType.CAR] });
    expect(await homeRequestIds(repo, d.user.id)).toEqual([seed.id]);
    // Old positions remain available for manual discovery (unlike ringing).
    await source.query(`UPDATE driver_dispatch_presence SET "updatedAt"=now()-interval '3 days' WHERE "driverId"=$1`, [d.user.id]);
    expect((await browsing().findAll(d.user.id, true)).map(row => row.id)).toEqual([seed.id]);
    await source.query('DELETE FROM driver_dispatch_presence WHERE "driverId"=$1', [d.user.id]);
    expect(await browsing().findAll(d.user.id, true)).toEqual([]);
  });
}
