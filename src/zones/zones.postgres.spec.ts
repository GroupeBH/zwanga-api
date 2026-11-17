import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { OperationalZones1780000131000 } from '../database/migrations/1780000131000-OperationalZones';
import { ZoneRuntimeSettings1780000132000 } from '../database/migrations/1780000132000-ZoneRuntimeSettings';
import { ZonesService } from './zones.service';
import { ZonesWorker } from './zones.worker';
import { SaveZoneDto } from './zones.dto';

const bin = process.env.ZONES_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'Operational zones real PostGIS (isolated database)',
  () => {
    const cluster = new IsolatedPostgres(bin!);
    let db: DataSource, service: ZonesService, worker: ZonesWorker;
    const actor = randomUUID();
    const history = { getDriverLocationHistory: jest.fn() };
    const zone = (name = 'Gombe', priority = 0): SaveZoneDto => ({
      name,
      description: '',
      priority,
      active: true,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [15, -4],
            [15.01, -4],
            [15.01, -3.99],
            [15, -3.99],
            [15, -4],
          ],
        ],
      },
    });
    beforeAll(async () => {
      db = await cluster.start();
      await db.query(`CREATE EXTENSION postgis;
      CREATE TABLE trips(id uuid PRIMARY KEY,status text,"departurePoint" geography(Point,4326),"arrivalPoint" geography(Point,4326),"updatedAt" timestamptz DEFAULT now());
      CREATE TABLE trip_requests(LIKE trips INCLUDING ALL);
      ALTER TABLE trip_requests ADD COLUMN "tripId" uuid;`);
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await new OperationalZones1780000131000().up(runner);
        await new ZoneRuntimeSettings1780000132000().up(runner);
        await runner.commitTransaction();
      } catch (e) {
        await runner.rollbackTransaction();
        throw e;
      } finally {
        await runner.release();
      }
      service = new ZonesService(db);
      worker = new ZonesWorker(db, service, history as any);
    }, 120000);
    afterAll(() => cluster.stop(), 40000);
    beforeEach(async () => {
      history.getDriverLocationHistory.mockReset().mockResolvedValue(null);
      await db.query(
        'TRUNCATE zone_events,zone_assignments,zone_audit_logs,zones,trips,trip_requests CASCADE',
      );
      await db.query('TRUNCATE zone_settings_audit');
      await db.query('UPDATE zone_settings SET enabled=true,version=1');
    });
    const addTrip = async (
      status = 'ongoing',
      departure = '15.005 -3.995',
      arrival = '16 -4',
    ) => {
      const id = randomUUID();
      await db.query(
        'INSERT INTO trips(id,status,"departurePoint","arrivalPoint") VALUES($1,$2,ST_GeogFromText($3),ST_GeogFromText($4))',
        [id, status, `POINT(${departure})`, `POINT(${arrival})`],
      );
      return id;
    };
    it('creates, audits, updates and protects against lost updates', async () => {
      const created = await service.save(actor, zone());
      expect(created.geometry.type).toBe('MultiPolygon');
      const updated = await service.save(
        actor,
        { ...zone(), active: false, version: 1 },
        created.id,
      );
      expect(updated.version).toBe(2);
      await expect(
        service.save(actor, { ...zone(), version: 1 }, created.id),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await service.audit(created.id, { page: 1, limit: 20 })).total,
      ).toBe(2);
      expect((await service.list({ page: 1, limit: 20 })).total).toBe(1);
      expect((await service.list({ page: 2, limit: 20 })).items).toHaveLength(
        0,
      );
    });
    it('rejects self intersections and holes outside the polygon without saving', async () => {
      const dto = zone();
      dto.geometry = {
        type: 'Polygon',
        coordinates: [
          [
            [15, -4],
            [16, -3],
            [16, -4],
            [15, -3],
            [15, -4],
          ],
        ],
      };
      await expect(service.save(actor, dto)).rejects.toMatchObject({
        status: 400,
      });
      expect((await service.list({ page: 1, limit: 20 })).total).toBe(0);
    });
    it('assigns boundary points, overlapping priority and an uncovered arrival independently', async () => {
      await service.save(actor, zone('Priority low', 0));
      const high = await service.save(actor, zone('Priority high', 5));
      const id = await addTrip('ongoing', '15 -4');
      await worker.tick();
      const [a] = await db.query(
        'SELECT * FROM zone_assignments WHERE "tripId"=$1',
        [id],
      );
      expect(a.departureZoneId).toBe(high.id);
      expect(a.arrivalZoneId).toBeNull();
      expect((await service.assignments({ page: 1, limit: 20 })).total).toBe(1);
    });
    it('excludes polygon holes and inactive zones', async () => {
      const dto = zone();
      (dto.geometry.coordinates as number[][][]).push([
        [15.002, -3.998],
        [15.008, -3.998],
        [15.008, -3.992],
        [15.002, -3.992],
        [15.002, -3.998],
      ]);
      await service.save(actor, dto);
      await service.save(actor, {
        ...zone('Inactive'),
        active: false,
        priority: 100,
      });
      const id = await addTrip();
      await worker.tick();
      const [a] = await db.query(
        'SELECT * FROM zone_assignments WHERE "tripId"=$1',
        [id],
      );
      expect(a.departureZoneId).toBeNull();
    });
    it('attributes requests without blocking them outside coverage', async () => {
      await service.save(actor, zone());
      const id = randomUUID();
      await db.query(
        `INSERT INTO trip_requests(id,status,"departurePoint","arrivalPoint") VALUES($1,'pending',ST_GeogFromText('POINT(16 -4)'),ST_GeogFromText('POINT(15.005 -3.995)'))`,
        [id],
      );
      await worker.tick();
      const [a] = await db.query(
        'SELECT * FROM zone_assignments WHERE "requestId"=$1',
        [id],
      );
      expect(a.departureZoneId).toBeNull();
      expect(a.arrivalZoneId).not.toBeNull();
      expect(
        (
          await db.query('SELECT status FROM trip_requests WHERE id=$1', [id])
        )[0].status,
      ).toBe('pending');
    });
    const fixes = (longitude: number, accuracyMeters = 10) => ({
      samples: [-30000, -20000, -10000].map((offset) => ({
        latitude: -3.995,
        longitude,
        accuracyMeters,
        recordedAt: new Date(Date.now() + offset).toISOString(),
      })),
    });
    const due = () =>
      db.query(
        `UPDATE zone_assignments SET "checkedAt"=now()-interval '1 minute'`,
      );
    const ageCatalog = () =>
      db.query(`UPDATE zone_catalog SET "changedAt"=now()-interval '1 minute'`);
    it('records an exit once, persists deduplication, and records a confirmed return', async () => {
      await service.save(actor, zone());
      const id = await addTrip();
      await ageCatalog();
      const snapshot = fixes(16);
      history.getDriverLocationHistory.mockResolvedValue(snapshot);
      await Promise.all([
        worker.tick(),
        new ZonesWorker(db, service, history as any).tick(),
      ]);
      expect((await service.events({ page: 1, limit: 20 })).total).toBe(1);
      await due();
      await new ZonesWorker(db, service, history as any).tick();
      expect((await service.events({ page: 1, limit: 20 })).total).toBe(1);
      // Continue with strictly later, fresh observations, no waiting on wall time.
      await db.query(
        'UPDATE zone_assignments SET monitor=$1 WHERE "tripId"=$2',
        [JSON.stringify({ outside: true, lastAt: Date.now() - 45000 }), id],
      );
      history.getDriverLocationHistory.mockResolvedValue(fixes(15.005));
      await due();
      await worker.tick();
      expect(
        (await service.events({ page: 1, limit: 20 })).items.map((e) => e.kind),
      ).toEqual(['returned', 'outside']);
    });
    it('does not alert on border jitter, poor GPS, or an empty catalog', async () => {
      const z = await service.save(actor, zone());
      await addTrip();
      await ageCatalog();
      history.getDriverLocationHistory.mockResolvedValue(fixes(15.0102));
      await worker.tick();
      expect((await service.events({ page: 1, limit: 20 })).total).toBe(0);
      history.getDriverLocationHistory.mockResolvedValue(fixes(16, 100));
      await due();
      await worker.tick();
      expect((await service.events({ page: 1, limit: 20 })).total).toBe(0);
      await service.save(actor, { ...zone(), active: false, version: 1 }, z.id);
      history.getDriverLocationHistory.mockResolvedValue(fixes(16));
      await due();
      await worker.tick();
      expect((await service.events({ page: 1, limit: 20 })).total).toBe(0);
    });
    it('pauses across instances without hiding configuration and audits each change', async () => {
      const result = await service.updateSettings(actor, {
        enabled: false,
        version: 1,
      });
      expect(result).toMatchObject({ enabled: false, ready: true, version: 2 });
      const other = new ZonesService(db);
      expect(await other.status()).toMatchObject({
        enabled: false,
        ready: true,
      });
      await service.save(actor, zone());
      await addTrip();
      await new ZonesWorker(db, other, history as any).tick();
      expect((await other.list({ page: 1, limit: 20 })).total).toBe(1);
      expect((await other.assignments({ page: 1, limit: 20 })).total).toBe(0);
      await expect(
        other.updateSettings(actor, { enabled: true, version: 1 }),
      ).rejects.toMatchObject({ status: 409 });
      await other.updateSettings(actor, { enabled: true, version: 2 });
      await other.updateSettings(actor, { enabled: true, version: 3 });
      await worker.tick();
      expect((await other.assignments({ page: 1, limit: 20 })).total).toBe(1);
      expect(
        (
          await db.query('SELECT * FROM zone_settings_audit ORDER BY version')
        ).map((r) => r.enabled),
      ).toEqual([false, true]);
    });
    it('serializes concurrent setting changes and discards pre-resume GPS', async () => {
      const results = await Promise.allSettled([
        service.updateSettings(actor, { enabled: false, version: 1 }),
        service.updateSettings(actor, { enabled: false, version: 1 }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      await service.save(actor, zone());
      await addTrip();
      history.getDriverLocationHistory.mockResolvedValue(fixes(16));
      await service.updateSettings(actor, { enabled: true, version: 2 });
      await worker.tick();
      expect((await service.events({ page: 1, limit: 20 })).total).toBe(0);
    });
    it('never reclassifies old GPS against a newly changed boundary', async () => {
      const z = await service.save(actor, zone());
      await addTrip();
      await ageCatalog();
      history.getDriverLocationHistory.mockResolvedValue(fixes(16));
      await worker.tick();
      expect((await service.events({ page: 1, limit: 20 })).total).toBe(1);
      await service.save(actor, { ...zone(), version: 1 }, z.id);
      await due();
      await worker.tick();
      expect((await service.events({ page: 1, limit: 20 })).total).toBe(1);
    });
    it('rotates bounded batches without starving remaining active trips', async () => {
      await service.save(actor, zone());
      await db.query(`INSERT INTO trips(id,status,"departurePoint","arrivalPoint") SELECT gen_random_uuid(),'upcoming',
      ST_GeogFromText('POINT(15.005 -3.995)'),ST_GeogFromText('POINT(15.005 -3.995)') FROM generate_series(1,205)`);
      await worker.tick();
      expect((await service.assignments({ page: 1, limit: 20 })).total).toBe(
        200,
      );
      await worker.tick();
      expect((await service.assignments({ page: 1, limit: 20 })).total).toBe(
        205,
      );
    });
    it('picks the smaller polygon when priorities match', async () => {
      await service.save(actor, {
        ...zone('Large'),
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [14, -5],
              [17, -5],
              [17, -2],
              [14, -2],
              [14, -5],
            ],
          ],
        },
      });
      const small = await service.save(actor, zone('Small'));
      await addTrip();
      await worker.tick();
      expect(
        (await service.assignments({ page: 1, limit: 20 })).items[0]
          .departureZoneId,
      ).toBe(small.id);
    });
  },
);
