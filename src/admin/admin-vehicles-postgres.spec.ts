import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { DataSource, Table } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { KycDocument } from '../users/entities/kyc-document.entity';
import { Vehicle, VehicleType } from '../vehicles/entities/vehicle.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import {
  RecurringTripTemplate,
  RecurringTripTemplateStatus,
} from '../trips/entities/recurring-trip-template.entity';
import { VehiclesService } from '../vehicles/vehicles.service';
import { AdminVehiclesService } from './admin-vehicles.service';
import { CacheService } from '../common/services/cache.service';

// Disposable localhost cluster, real repositories and vehicle business service.
// Only image signing and cache are mocked; no .env, AWS, Redis or application DB.
const bin = process.env.AUDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'admin vehicle operations on isolated PostgreSQL/PostGIS',
  () => {
    let cluster: IsolatedPostgres,
      db: DataSource,
      service: AdminVehiclesService,
      admin: User,
      owner: User;
    const cache = { del: jest.fn().mockResolvedValue(undefined) };
    const files = { getPresignedUrlIfS3Key: jest.fn(async () => null) };
    beforeAll(async () => {
      cluster = new IsolatedPostgres(bin!);
      db = await cluster.start();
      db.setOptions({ entities: typeOrmEntities });
      await (db as any).buildMetadatas();
      await db.query('CREATE EXTENSION "uuid-ossp"');
      await db.query('CREATE EXTENSION postgis');
      const runner = db.createQueryRunner();
      try {
        for (const entity of [
          User,
          Vehicle,
          KycDocument,
          RecurringTripTemplate,
          Trip,
        ]) {
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
      const operations = new VehiclesService(
        db.getRepository(Vehicle),
        db.getRepository(User),
        db.getRepository(Trip),
        db.getRepository(RecurringTripTemplate),
        cache as any,
        files as any,
      );
      service = new AdminVehiclesService(
        db.getRepository(Vehicle),
        db.getRepository(User),
        operations,
        files as any,
      );
    }, 90_000);
    beforeEach(async () => {
      await db.query(
        'TRUNCATE trips, recurring_trip_templates, kyc_documents, vehicles, users',
      );
      cache.del.mockClear();
      admin = await db
        .getRepository(User)
        .save({
          firstName: 'Synthetic',
          lastName: 'Admin',
          role: UserRole.ADMIN,
          status: UserStatus.ACTIVE,
          isActive: true,
        });
      owner = await db
        .getRepository(User)
        .save({
          firstName: 'Synthetic',
          lastName: 'Owner',
          role: UserRole.DRIVER,
          status: UserStatus.ACTIVE,
          isActive: true,
          password: 'synthetic-never-expose',
          accessToken: 'synthetic-secret',
          refreshToken: 'synthetic-secret',
        });
    });
    afterAll(async () => {
      await cluster?.stop();
    });

    const addVehicle = (overrides: Partial<Vehicle> = {}) =>
      db.getRepository(Vehicle).save({
        ownerId: owner.id,
        type: VehicleType.CAR,
        brand: 'Test',
        model: 'Test',
        color: 'Blue',
        licensePlate: randomUUID(),
        isActive: true,
        ...overrides,
      });
    const addTrip = (vehicleId: string, status: TripStatus) =>
      db.getRepository(Trip).save({
        driverId: owner.id,
        vehicleId,
        status,
        departureLocation: 'Test departure',
        arrivalLocation: 'Test arrival',
        departureDate: new Date('2099-01-01T12:00:00Z'),
        totalSeats: 4,
        availableSeats: 4,
        pricePerSeat: 100,
      });

    it.each(Object.values(VehicleType))(
      'lists %s vehicles across owners and states with correct totals',
      async (type) => {
        const otherOwner = await db
          .getRepository(User)
          .save({ firstName: 'Other', lastName: 'Synthetic' });
        const active = await addVehicle({ type });
        const inactive = await addVehicle({
          type,
          ownerId: otherOwner.id,
          isActive: false,
        });
        await addVehicle({
          type: Object.values(VehicleType).find((value) => value !== type)!,
        });
        const all = await service.list(admin.id, {
          page: 1,
          limit: 25,
          vehicleType: type,
        });
        expect(all.total).toBe(2);
        expect(new Set(all.vehicles.map((vehicle) => vehicle.id))).toEqual(
          new Set([active.id, inactive.id]),
        );
        const enabled = await service.list(admin.id, {
          page: 1,
          limit: 25,
          vehicleType: type,
          isActive: 'true',
        });
        expect(enabled.total).toBe(1);
        expect(enabled.vehicles[0].id).toBe(active.id);
        const disabled = await service.list(admin.id, {
          page: 1,
          limit: 25,
          vehicleType: type,
          isActive: 'false',
        });
        expect(disabled.total).toBe(1);
        expect(disabled.vehicles[0].owner?.id).toBe(otherOwner.id);
        expect(JSON.stringify(all)).not.toMatch(
          /synthetic-secret|synthetic-never-expose|password|refreshToken|accessToken/,
        );
        expect((await service.get(admin.id, inactive.id)).isActive).toBe(false);
      },
    );

    it('paginates deterministically by creation date and id without duplicate vehicles', async () => {
      const createdAt = new Date('2026-10-01T00:00:00Z');
      const vehicles = await Promise.all([
        addVehicle({ createdAt }),
        addVehicle({ createdAt }),
        addVehicle({ createdAt }),
      ]);
      const expected = vehicles
        .map((vehicle) => vehicle.id)
        .sort()
        .reverse();
      const result = [];
      for (const page of [1, 2, 3, 4]) {
        const value = await service.list(admin.id, { page, limit: 1 });
        expect(value.total).toBe(3);
        result.push(...value.vehicles.map((vehicle) => vehicle.id));
      }
      expect(result).toEqual(expected);
    });

    it('edits and normalizes the vehicle, preserves ownership and invalidates existing caches', async () => {
      const vehicle = await addVehicle();
      const edited = await service.update(admin.id, vehicle.id, {
        brand: ' New brand ',
        licensePlate: 'test- 001',
        type: VehicleType.MOTORCYCLE_TWO_WHEELS,
      });
      expect(edited).toEqual(
        expect.objectContaining({
          ownerId: owner.id,
          brand: 'New brand',
          licensePlate: 'TEST001',
          type: VehicleType.MOTORCYCLE_TWO_WHEELS,
        }),
      );
      expect(cache.del).toHaveBeenCalledWith(
        CacheService.getVehicleKey(vehicle.id),
      );
      expect(cache.del).toHaveBeenCalledWith(
        CacheService.getVehiclesByOwnerKey(owner.id),
      );
      const saved = await db
        .getRepository(Vehicle)
        .findOneByOrFail({ id: vehicle.id });
      expect(saved.ownerId).toBe(owner.id);
      expect(saved.licensePlate).toBe('TEST001');
    });

    it('keeps normalized plate uniqueness and active trip seat limits', async () => {
      const vehicle = await addVehicle({ licensePlate: 'FIRST01' });
      await addVehicle({ licensePlate: 'TAKEN01' });
      await expect(
        service.update(admin.id, vehicle.id, { licensePlate: 'taken- 01' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await addTrip(vehicle.id, TripStatus.PENDING);
      await expect(
        service.update(admin.id, vehicle.id, {
          type: VehicleType.MOTORCYCLE_TWO_WHEELS,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      const saved = await db
        .getRepository(Vehicle)
        .findOneByOrFail({ id: vehicle.id });
      expect(saved.licensePlate).toBe('FIRST01');
      expect(saved.type).toBe(VehicleType.CAR);
    });

    it.each([TripStatus.ACTIVE, TripStatus.PENDING])(
      'blocks deactivation through either endpoint when a trip is %s',
      async (status) => {
        const vehicle = await addVehicle();
        await addTrip(vehicle.id, status);
        for (const call of [
          () => service.deactivate(admin.id, vehicle.id),
          () => service.update(admin.id, vehicle.id, { isActive: false }),
        ]) {
          await expect(call()).rejects.toMatchObject({
            response: expect.objectContaining({
              code: 'VEHICLE_HAS_ACTIVE_TRIPS',
            }),
          });
        }
        expect(
          (await db.getRepository(Vehicle).findOneByOrFail({ id: vehicle.id }))
            .isActive,
        ).toBe(true);
      },
    );

    it('blocks active recurring templates and permits soft-deactivation once paused', async () => {
      const vehicle = await addVehicle();
      const template = await db.getRepository(RecurringTripTemplate).save({
        driverId: owner.id,
        vehicleId: vehicle.id,
        departureLocation: 'Test departure',
        arrivalLocation: 'Test arrival',
        departureTimeMinutes: 600,
        weekdays: [1],
        startDate: '2026-10-01',
        endDate: null,
        totalSeats: 4,
        pricePerSeat: 100,
        status: RecurringTripTemplateStatus.ACTIVE,
      });
      await expect(
        service.deactivate(admin.id, vehicle.id),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'VEHICLE_HAS_ACTIVE_RECURRING_TRIPS',
        }),
      });
      await db
        .getRepository(RecurringTripTemplate)
        .update(template.id, { status: RecurringTripTemplateStatus.PAUSED });
      await service.deactivate(admin.id, vehicle.id);
      expect(
        (await db.getRepository(Vehicle).findOneByOrFail({ id: vehicle.id }))
          .isActive,
      ).toBe(false);
      expect(await db.getRepository(RecurringTripTemplate).count()).toBe(1);
    });

    it('retains vehicle and completed/cancelled trip history, including repeated deactivation', async () => {
      const vehicle = await addVehicle();
      await addTrip(vehicle.id, TripStatus.COMPLETED);
      await addTrip(vehicle.id, TripStatus.CANCELLED);
      await service.deactivate(admin.id, vehicle.id);
      await service.deactivate(admin.id, vehicle.id);
      expect(await db.getRepository(Vehicle).count()).toBe(1);
      expect(await db.getRepository(Trip).count()).toBe(2);
      expect((await service.get(admin.id, vehicle.id)).isActive).toBe(false);
      expect(
        (await service.list(admin.id, { page: 1, limit: 25, isActive: 'true' }))
          .total,
      ).toBe(0);
      expect(cache.del).toHaveBeenCalledWith(
        CacheService.getVehiclesByOwnerKey(owner.id),
      );
    });
  },
);
