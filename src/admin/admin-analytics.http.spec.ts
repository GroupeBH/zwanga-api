import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminReferralsService } from './admin-referrals.service';
import { TripStatementService } from './trip-statement.service';
import { SafetyController } from '../safety/safety.controller';
import { SafetyService } from '../safety/safety.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { FinanceOtpGuard } from '../otp/finance-otp.guard';

describe('admin analytics HTTP contracts (isolated synthetic authentication)', () => {
  let app: INestApplication;
  const id = '00000000-0000-4000-8000-000000000001';
  const analytics = {
    overview: jest.fn(),
    paymentStats: jest.fn(),
    promotionsStats: jest.fn(),
    ratingsStats: jest.fn(),
    search: jest.fn(),
  };
  const admin = {
    getAllTrips: jest.fn(),
    getKycDocuments: jest.fn(),
    getAllPayments: jest.fn(),
    getAllBookings: jest.fn(),
    getAllTripRequests: jest.fn(),
    acceptBooking: jest.fn(),
    rejectBooking: jest.fn(),
    cancelBooking: jest.fn(),
  };
  const safety = {
    listAdminUserReports: jest.fn(),
    adminReportStats: jest.fn(),
    updateReportStatus: jest.fn(),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        AdminController,
        AdminAnalyticsController,
        SafetyController,
      ],
      providers: [
        { provide: AdminService, useValue: admin },
        { provide: AdminAnalyticsService, useValue: analytics },
        { provide: AdminReferralsService, useValue: {} },
        { provide: TripStatementService, useValue: {} },
        { provide: SafetyService, useValue: safety },
      ],
    })
      .overrideGuard(FinanceOtpGuard).useValue({ canActivate: () => true })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalGuards(
      {
        canActivate(context) {
          const req = context.switchToHttp().getRequest();
          const role = req.headers['x-test-role'];
          if (!role) throw new UnauthorizedException();
          req.user = { userId: 'actor-from-session', role };
          return true;
        },
      },
      new RolesGuard(new Reflector()),
    );
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.listen(0, '127.0.0.1');
  });
  afterAll(() => app?.close());
  beforeEach(() => {
    jest.clearAllMocks();
    admin.getAllTrips.mockResolvedValue({
      trips: [],
      total: 2500,
      page: 2,
      limit: 10,
    });
    admin.getKycDocuments.mockResolvedValue({
      documents: [],
      total: 2500,
      page: 300,
      limit: 10,
    });
    safety.listAdminUserReports.mockResolvedValue({
      reports: [],
      total: 2500,
      page: 300,
      limit: 10,
    });
  });
  const routes = [
    'admin/analytics/overview',
    'admin/payments/stats',
    'admin/ratings/stats',
    'admin/evaluations/stats',
    'admin/promotions/stats',
    'admin/search?q=123',
    'safety/admin/reports/stats',
  ];
  it.each(routes)(
    'protects GET %s from unauthenticated and non-admin users',
    async (route) => {
      await request(app.getHttpServer()).get(`/api/v1/${route}`).expect(401);
      for (const role of [
        UserRole.DRIVER,
        UserRole.PASSENGER,
        UserRole.MARKETER,
      ]) {
        await request(app.getHttpServer())
          .get(`/api/v1/${route}`)
          .set('x-test-role', role)
          .expect(403);
      }
      for (const fn of Object.values(analytics))
        expect(fn).not.toHaveBeenCalled();
    },
  );
  it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN])(
    'accepts %s, binds date/group options and does not shadow payment routes',
    async (role) => {
      await request(app.getHttpServer())
        .get(
          '/api/v1/admin/analytics/overview?from=2026-10-01&to=2026-10-31&compare=previous',
        )
        .set('x-test-role', role)
        .expect(200);
      expect(analytics.overview).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '2026-10-01',
          to: '2026-10-31',
          compare: 'previous',
        }),
      );
      await request(app.getHttpServer())
        .get('/api/v1/admin/payments/stats?groupBy=operator')
        .set('x-test-role', role)
        .expect(200);
      expect(analytics.paymentStats).toHaveBeenCalledWith(
        expect.objectContaining({ groupBy: 'operator' }),
      );
    },
  );
  it('forwards list filters to the database and keeps total for out-of-range pages', async () => {
    const response = await request(app.getHttpServer())
      .get(
        '/api/v1/admin/trips?page=2&limit=10&search=Gombe&status=completed&from=2026-10-01&to=2026-10-31&sort=departureDate:asc',
      )
      .set('x-test-role', 'admin')
      .expect(200);
    expect(response.body).toEqual({
      trips: [],
      total: 2500,
      page: 2,
      limit: 10,
    });
    expect(admin.getAllTrips).toHaveBeenCalledWith(2, 10, {
      search: 'Gombe',
      status: 'completed',
      from: '2026-10-01',
      to: '2026-10-31',
      sort: 'departureDate:asc',
    });
    for (const route of ['admin/kyc?status=pending', 'safety/admin/reports']) {
      const result = await request(app.getHttpServer())
        .get(`/api/v1/${route}`)
        .set('x-test-role', 'admin')
        .expect(200);
      expect(result.body.total).toBe(2500);
    }
  });
  it('rejects invalid statistical query options and forged bulk actor IDs', async () => {
    for (const route of [
      'admin/payments/stats?groupBy=raw',
      'admin/analytics/overview?compare=bad',
      'admin/search',
      'admin/analytics/overview?unknown=true',
    ]) {
      await request(app.getHttpServer())
        .get(`/api/v1/${route}`)
        .set('x-test-role', 'admin')
        .expect(400);
    }
    await request(app.getHttpServer())
      .post('/api/v1/admin/bookings/bulk-status')
      .set('x-test-role', 'admin')
      .send({ ids: [id], status: 'accepted', adminId: 'forged' })
      .expect(400);
    expect(admin.acceptBooking).not.toHaveBeenCalled();
  });
  it.each(['admin/bookings/bulk-status', 'safety/admin/reports/bulk-status'])(
    'protects POST %s and rejects duplicates before any mutation',
    async (route) => {
      await request(app.getHttpServer()).post(`/api/v1/${route}`).expect(401);
      await request(app.getHttpServer())
        .post(`/api/v1/${route}`)
        .set('x-test-role', 'driver')
        .expect(403);
      await request(app.getHttpServer())
        .post(`/api/v1/${route}`)
        .set('x-test-role', 'admin')
        .send({ ids: [id, id], status: 'resolved' })
        .expect(400);
      expect(safety.updateReportStatus).not.toHaveBeenCalled();
      expect(admin.acceptBooking).not.toHaveBeenCalled();
    },
  );
  it('executes report and booking batches with the authenticated actor', async () => {
    const report = await request(app.getHttpServer())
      .post('/api/v1/safety/admin/reports/bulk-status')
      .set('x-test-role', 'super_admin')
      .send({ ids: [id], status: 'resolved', adminNotes: 'Vérifié' })
      .expect(201);
    expect(report.body).toMatchObject({ succeeded: 1, failed: 0 });
    expect(safety.updateReportStatus).toHaveBeenCalledWith(
      id,
      'actor-from-session',
      expect.objectContaining({ status: 'resolved' }),
    );
    const booking = await request(app.getHttpServer())
      .post('/api/v1/admin/bookings/bulk-status')
      .set('x-test-role', 'admin')
      .send({ ids: [id], status: 'cancelled' })
      .expect(201);
    expect(booking.body).toMatchObject({ succeeded: 1, failed: 0 });
    expect(admin.cancelBooking).toHaveBeenCalledWith(id, 'actor-from-session');
  });
});
