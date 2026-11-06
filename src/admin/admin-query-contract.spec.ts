import {
  BadRequestException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AdminPaymentStatsDto,
  adminRange,
  applyAdminList,
} from '../common/pagination/admin-query';
import { runAdminBulk } from '../common/pagination/admin-bulk';
import { AdminBulkBookingsDto } from './dto/admin-bulk-bookings.dto';
import { BulkReportStatusDto } from '../safety/dto/user-report.dto';
import { AdminController } from './admin.controller';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { SafetyController } from '../safety/safety.controller';
import { StoreController } from '../store-management/store.controller';
import { StorePageDto } from '../store-management/store.dto';
import { UserRole } from '../users/entities/user.entity';
import { ROLES_KEY } from '../common/guards/roles.guard';

const id = '00000000-0000-4000-8000-000000000001';
describe('admin dates, sorting, batch and Store contracts', () => {
  it('uses inclusive UTC calendar days and exclusive timestamp bounds', () => {
    expect(adminRange({ from: '2026-10-01', to: '2026-10-01' })).toEqual({
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-02T00:00:00Z'),
    });
    expect(adminRange({ to: '2026-10-01T01:00:00+01:00' }).to).toEqual(
      new Date('2026-10-01T00:00:00Z'),
    );
    expect(adminRange({}, true, new Date('2026-10-31T10:00:00Z'))).toEqual({
      from: new Date('2026-10-02'),
      to: new Date('2026-11-01'),
    });
  });
  it.each([
    '2026-02-30',
    '2026-13-01',
    'yesterday',
    "2026-01-01'; DROP TABLE trips",
    '2026-01-01T12:00:00',
    ['2026-01-01'],
    '',
  ])('rejects invalid or ambiguous date %j', (value) => {
    expect(() => adminRange({ from: value as any })).toThrow(
      BadRequestException,
    );
  });
  it('rejects reversed periods and unbounded statistical windows', () => {
    expect(() => adminRange({ from: '2026-10-03', to: '2026-10-01' })).toThrow(
      BadRequestException,
    );
    expect(() =>
      adminRange({ from: '2020-01-01', to: '2026-01-01' }, true),
    ).toThrow(BadRequestException);
  });
  it.each([
    'password:asc',
    'createdAt;drop:desc',
    'createdAt:desc nulls first',
    ['createdAt:asc'],
    'createdAt',
  ])('rejects unsafe sorting %j', (sort) => {
    const qb = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn(),
      addOrderBy: jest.fn(),
    };
    expect(() =>
      applyAdminList(qb as any, 'trip', { sort: sort as any }),
    ).toThrow(BadRequestException);
    expect(qb.orderBy).not.toHaveBeenCalled();
  });
  it('uses bound date parameters and a deterministic ID tie breaker', () => {
    const qb = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
    };
    applyAdminList(qb as any, 'trip', {
      from: '2026-10-01',
      to: '2026-10-01',
      sort: 'createdAt:asc',
    });
    expect(qb.orderBy).toHaveBeenCalledWith('trip.createdAt', 'ASC');
    expect(qb.addOrderBy).toHaveBeenCalledWith('trip.id', 'ASC');
    expect(qb.andWhere).toHaveBeenCalledWith('trip.createdAt < :adminTo', {
      adminTo: new Date('2026-10-02'),
    });
  });
  it.each([
    { ids: [], status: 'cancelled' },
    { ids: [id, id], status: 'cancelled' },
    { ids: [id], status: 'completed' },
    { ids: ['not-uuid'], status: 'accepted' },
    {
      ids: Array.from(
        { length: 51 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ),
      status: 'cancelled',
    },
  ])(
    'validates batch size, IDs, uniqueness and supported business transitions %j',
    async (value) => {
      expect(
        (await validate(plainToInstance(AdminBulkBookingsDto, value))).length,
      ).toBeGreaterThan(0);
    },
  );
  it('validates report batches and payment groupBy', async () => {
    expect(
      await validate(
        plainToInstance(BulkReportStatusDto, { ids: [id], status: 'resolved' }),
      ),
    ).toEqual([]);
    expect(
      (
        await validate(
          plainToInstance(BulkReportStatusDto, { ids: [id], status: 'fake' }),
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await validate(
          plainToInstance(AdminPaymentStatsDto, { groupBy: 'secret' }),
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it('reports partial failures without leaking SQL, and continues safely', async () => {
    const fn = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new NotFoundException('Introuvable'))
      .mockRejectedValueOnce(new Error('SQL secret'));
    expect(await runAdminBulk(['1', '2', '3'], fn)).toMatchObject({
      total: 3,
      succeeded: 1,
      failed: 2,
      results: [
        { id: '1', success: true },
        { id: '2', statusCode: 404, message: 'Introuvable' },
        { id: '3', statusCode: 500 },
      ],
    });
    expect(
      JSON.stringify(
        await runAdminBulk(['4'], async () => {
          throw new Error('SQL secret');
        }),
      ),
    ).not.toContain('SQL secret');
  });
  it.each(['accepted', 'rejected', 'cancelled'] as const)(
    'delegates %s bookings to existing business operations using JWT actor',
    async (status) => {
      const service = {
        acceptBooking: jest.fn(),
        rejectBooking: jest.fn(),
        cancelBooking: jest.fn(),
      };
      const controller = new AdminController(
        service as any,
        {} as any,
        {} as any,
      );
      await controller.bulkBookings(
        { user: { userId: 'admin' } },
        { ids: [id], status },
      );
      const method = {
        accepted: 'acceptBooking',
        rejected: 'rejectBooking',
        cancelled: 'cancelBooking',
      }[status];
      expect(service[method].mock.calls[0].slice(0, 2)).toEqual([id, 'admin']);
    },
  );
  it('requires existing admin permissions on all added routes and batch operations', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminAnalyticsController)).toEqual([
      UserRole.ADMIN,
    ]);
    for (const method of [
      SafetyController.prototype.reportStats,
      SafetyController.prototype.bulkReports,
      AdminController.prototype.bulkBookings,
    ]) {
      expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual([UserRole.ADMIN]);
    }
  });
  it('allows limit=100 on stores/syncs, validates the DTO and forwards it unchanged', async () => {
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const query = await pipe.transform(
      { limit: '100', page: '1' },
      { type: 'query', metatype: StorePageDto },
    );
    const service = {
      history: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };
    await new StoreController(service as any, {} as any).history(query);
    expect(service.history).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, page: 1 }),
    );
    await expect(
      pipe.transform(
        { limit: '101' },
        { type: 'query', metatype: StorePageDto },
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
