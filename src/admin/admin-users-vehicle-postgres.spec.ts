import { randomUUID } from 'crypto';
import { DataSource, Table } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { User, UserRole } from '../users/entities/user.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import { Vehicle, VehicleType } from '../vehicles/entities/vehicle.entity';
import { AdminService } from './admin.service';

// Opt-in disposable loopback cluster; never loads .env or an application DB URL.
const bin = process.env.AUDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'admin vehicle filters on isolated PostgreSQL',
  () => {
    let cluster: IsolatedPostgres, db: DataSource, service: AdminService;

    beforeAll(async () => {
      cluster = new IsolatedPostgres(bin!);
      db = await cluster.start();
      db.setOptions({ entities: typeOrmEntities });
      await (db as any).buildMetadatas();
      await db.query('CREATE EXTENSION "uuid-ossp"');
      const runner = db.createQueryRunner();
      try {
        for (const entity of [User, Vehicle, KycDocument]) {
          await runner.createTable(
            Table.create(db.getMetadata(entity), db.driver),
            false,
            false,
            false,
          );
        }
      } finally {
        await runner.release();
      }
      service = new AdminService(
        db.getRepository(User),
        db.getRepository(KycDocument),
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    }, 90_000);

    beforeEach(async () => {
      await db.query('TRUNCATE kyc_documents, vehicles, users');
    });
    afterAll(async () => {
      await cluster?.stop();
    });

    const addUser = (overrides: Partial<User> = {}) =>
      db.getRepository(User).save({
        firstName: 'Synthetic',
        lastName: 'Test',
        role: UserRole.DRIVER,
        createdAt: new Date('2026-10-05T12:00:00Z'),
        ...overrides,
      });
    const addVehicle = (
      ownerId: string,
      type: VehicleType,
      overrides: Partial<Vehicle> = {},
    ) =>
      db.getRepository(Vehicle).save({
        ownerId,
        type,
        brand: 'Test',
        model: 'Test',
        color: 'Test',
        licensePlate: randomUUID(),
        isActive: true,
        ...overrides,
      });

    it.each(Object.values(VehicleType))(
      'filters list and export by an active %s, never an inactive vehicle',
      async (type) => {
        const matching = await addUser(),
          inactiveOnly = await addUser(),
          other = await addUser(),
          noVehicle = await addUser();
        await addVehicle(matching.id, type);
        await addVehicle(matching.id, type); // No duplicate owner or inflated count.
        await addVehicle(inactiveOnly.id, type, { isActive: false });
        await addVehicle(
          other.id,
          Object.values(VehicleType).find((value) => value !== type)!,
        );
        const result = await service.getAllUsers(
          1,
          10,
          undefined,
          undefined,
          undefined,
          undefined,
          type,
        );
        expect(result.total).toBe(1);
        expect(result.users).toHaveLength(1);
        expect(result.users[0]).toEqual(
          expect.objectContaining({
            id: matching.id,
            activeVehicleType: type,
            hasActiveVehicle: true,
          }),
        );
        const file = await service.exportUsersXls(
          undefined,
          undefined,
          undefined,
          undefined,
          type,
        );
        const xml = file.buffer.toString('utf8');
        expect(xml.split(matching.id)).toHaveLength(2);
        for (const user of [inactiveOnly, other, noVehicle])
          expect(xml).not.toContain(user.id);
        expect(xml.match(/<Row>/g)).toHaveLength(2); // Header and one user.
      },
    );

    it('returns a matching type for multi-vehicle owners and a deterministic latest type without a filter', async () => {
      const user = await addUser(),
        absent = await addUser();
      const createdAt = new Date('2026-10-01T12:00:00Z');
      const car = await addVehicle(user.id, VehicleType.CAR, {
        createdAt,
        id: '10000000-0000-4000-8000-000000000001',
      });
      await addVehicle(user.id, VehicleType.MOTORCYCLE_TWO_WHEELS, {
        createdAt,
        id: '10000000-0000-4000-8000-000000000002',
      });
      await addVehicle(user.id, VehicleType.MOTORCYCLE_THREE_WHEELS, {
        isActive: false,
        createdAt: new Date('2026-10-18T12:00:00Z'),
      });
      const all = await service.getAllUsers();
      expect(
        all.users.find((value) => value.id === user.id)?.activeVehicleType,
      ).toBe(VehicleType.MOTORCYCLE_TWO_WHEELS);
      expect(
        all.users.find((value) => value.id === absent.id)?.activeVehicleType,
      ).toBeNull();
      const filtered = await service.getAllUsers(
        1,
        10,
        undefined,
        undefined,
        undefined,
        undefined,
        'car',
      );
      expect(filtered.users.map((value) => value.activeVehicleType)).toEqual([
        'car',
      ]);
      await db.getRepository(Vehicle).update(car.id, { isActive: false });
      const afterRemoval = await service.getAllUsers(
        1,
        10,
        undefined,
        undefined,
        undefined,
        undefined,
        'car',
      );
      expect(afterRemoval).toEqual({ users: [], total: 0 });
    });

    it('applies filtering before pagination and counts owners rather than vehicles', async () => {
      const older = await addUser(),
        newer = await addUser({ createdAt: new Date('2026-10-06T12:00:00Z') });
      for (const user of [older, newer]) {
        await addVehicle(user.id, VehicleType.CAR);
        await addVehicle(user.id, VehicleType.CAR);
      }
      const first = await service.getAllUsers(
        1,
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        'car',
      );
      const second = await service.getAllUsers(
        2,
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        'car',
      );
      const third = await service.getAllUsers(
        3,
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        'car',
      );
      expect([first.total, second.total, third.total]).toEqual([2, 2, 2]);
      expect(first.users.map((user) => user.id)).toEqual([newer.id]);
      expect(second.users.map((user) => user.id)).toEqual([older.id]);
      expect(third.users).toEqual([]);
      const xml = (
        await service.exportUsersXls(
          undefined,
          undefined,
          undefined,
          undefined,
          'car',
        )
      ).buffer.toString('utf8');
      expect(xml.match(/<Row>/g)).toHaveLength(3);
    });

    it('combines vehicle type with role/KYC, search and registration dates identically in the export', async () => {
      // The disposable cluster uses the C locale: exercise case folding with
      // ASCII names independently of the production collation's accent rules.
      const matching = await addUser({ firstName: 'Eric' });
      const noKyc = await addUser({ firstName: 'Eric' });
      const outOfRange = await addUser({
        firstName: 'Eric',
        createdAt: new Date('2026-09-01T12:00:00Z'),
      });
      const otherName = await addUser({ firstName: 'Autre' });
      const passenger = await addUser({
        firstName: 'Eric',
        role: UserRole.PASSENGER,
      });
      for (const user of [matching, noKyc, outOfRange, otherName, passenger]) {
        await addVehicle(user.id, VehicleType.CAR);
        if (user !== noKyc)
          await db
            .getRepository(KycDocument)
            .save({ userId: user.id, status: KycStatus.APPROVED });
      }
      const result = await service.getAllUsers(
        1,
        10,
        'driver',
        '2026-10-01',
        '2026-10-19',
        'ERIC',
        'car',
      );
      expect(result.total).toBe(1);
      expect(result.users[0]).toEqual(
        expect.objectContaining({
          id: matching.id,
          activeVehicleType: 'car',
          isQualifiedDriver: true,
        }),
      );
      const xml = (
        await service.exportUsersXls(
          'driver',
          '2026-10-01',
          '2026-10-19',
          'ERIC',
          'car',
        )
      ).buffer.toString('utf8');
      expect(xml).toContain(matching.id);
      for (const user of [noKyc, outOfRange, otherName, passenger])
        expect(xml).not.toContain(user.id);
    });
  },
);
