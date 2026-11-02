import type { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { User } from '../src/users/entities/user.entity';
import { Vehicle, VehicleType } from '../src/vehicles/entities/vehicle.entity';
import { TripRequest } from '../src/trip-requests/entities/trip-request.entity';
import { sequentialCandidates } from '../src/trip-requests/dispatch/sequential-candidates';
import { SequentialDispatchService } from '../src/trip-requests/dispatch/sequential-dispatch.service';
import { DriverDispatchService } from '../src/trip-requests/dispatch/dispatch.service';
import { findDriverChoices } from '../src/trip-requests/driver-choices';
import { requestMapCandidates } from '../src/trip-requests/request-search-map';
import { RequestVehicleTypes1780000104000 } from '../src/database/migrations/1780000104000-RequestVehicleTypes';

type Fixture = { db: DataSource; relay: SequentialDispatchService; dispatch: DriverDispatchService;
  driver: (longitude?: number) => Promise<User>; request: (immediate?: boolean) => Promise<TripRequest>;
  offers: (id: string) => Promise<any[]> };
const car = VehicleType.CAR, moto = VehicleType.MOTORCYCLE_TWO_WHEELS, tricycle = VehicleType.MOTORCYCLE_THREE_WHEELS;

export function multiVehicleRequestFlow(fixture: () => Fixture) {
  describe('multi-vehicle requests', () => {
    it.each(['refusal', 'timeout'])('relays across the selected types after %s, excluding other types and distant drivers', async outcome => {
      const { db, driver, request, relay, dispatch, offers } = fixture();
      const first = await driver(), second = await driver(15.311), excluded = await driver(15.3105), distant = await driver(16);
      await db.getRepository(Vehicle).update({ ownerId: second.id }, { type: moto });
      await db.getRepository(Vehicle).update({ ownerId: excluded.id }, { type: tricycle });
      const r = await request(true);
      await db.getRepository(TripRequest).update(r.id, { vehicleTypes: [car, moto] });
      const current = await db.getRepository(TripRequest).findOneByOrFail({ id: r.id });
      const candidates = await sequentialCandidates(db.manager, current);
      expect(candidates.map(c => c.driverId)).toEqual([first.id, second.id]);
      const choices = await findDriverChoices(db.manager, r.passengerId, { longitude: 15.31, latitude: -4.3, seats: 1, vehicleTypes: [car, moto] });
      expect(choices.map(c => c.id)).toEqual([first.id, second.id]);
      expect(choices[1].vehicleType).toBe(moto);
      expect((await requestMapCandidates(db.manager, r.passengerId, r.id)).map(c => c.driverId)).toEqual([first.id, second.id]);
      expect(candidates.some(c => c.driverId === distant.id)).toBe(false);
      await relay.advance(r.id);
      expect((await offers(r.id))[0].driverId).toBe(first.id);
      if (outcome === 'refusal') await dispatch.declineNearbyRequest(first.id, r.id);
      else await db.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second' WHERE "requestId"=$1`, [r.id]);
      await relay.advance(r.id);
      const pending = (await offers(r.id)).filter(o => o.status === 'pending');
      expect(pending).toHaveLength(1); expect(pending[0].driverId).toBe(second.id);
    });

    it('chooses a sufficiently large selected vehicle once per driver', async () => {
      const { db, driver, request } = fixture();
      const d = await driver();
      await db.query('UPDATE driver_dispatch_presence SET seats=1 WHERE "driverId"=$1', [d.id]);
      const alternate = await db.getRepository(Vehicle).save({ ownerId: d.id, brand: 'Test', model: 'Test',
        color: 'Test', licensePlate: randomUUID(), type: moto });
      const r = await request();
      await db.getRepository(TripRequest).update(r.id, { numberOfSeats: 2, vehicleTypes: [car, moto] });
      const candidates = await sequentialCandidates(db.manager, await db.getRepository(TripRequest).findOneByOrFail({ id: r.id }));
      expect(candidates).toHaveLength(1); expect(candidates[0].vehicleId).toBe(alternate.id);
    });

    it('keeps the legacy primary consistent, rejects invalid arrays and supports migration rollback', async () => {
      const { db, request } = fixture(); const r = await request();
      expect(r.vehicleTypes).toBeNull();
      await db.getRepository(TripRequest).update(r.id, { vehicleTypes: [moto, car] });
      expect((await db.getRepository(TripRequest).findOneByOrFail({ id: r.id })).vehicleType).toBe(moto);
      await db.query('UPDATE trip_requests SET "vehicleType"=$1 WHERE id=$2', [tricycle, r.id]);
      expect((await db.getRepository(TripRequest).findOneByOrFail({ id: r.id })).vehicleTypes).toEqual([tricycle]);
      for (const types of [[], [car, car], ['unknown'], [car, null]]) {
        await expect(db.query('UPDATE trip_requests SET "vehicleTypes"=$1::text[] WHERE id=$2', [types, r.id])).rejects.toThrow();
      }
      const runner = db.createQueryRunner(), migration = new RequestVehicleTypes1780000104000();
      try {
        await migration.down(runner);
        expect((await runner.query('SELECT "vehicleType" FROM trip_requests WHERE id=$1', [r.id]))[0].vehicleType).toBe(tricycle);
      } finally { try { await migration.up(runner); } finally { await runner.release(); } }
    });
  });
}
