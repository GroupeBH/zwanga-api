import { randomUUID } from 'node:crypto';
import { DataSource, In } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AdminService } from './admin.service';
import { SafetyService } from '../safety/safety.service';
import { SupportService } from '../support/support.service';
import { User, UserRole } from '../users/entities/user.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { TripRequest } from '../trip-requests/entities/trip-request.entity';
import { KycDocument } from '../users/entities/kyc-document.entity';
import {
  PaymentTransaction,
  PaymentMethod,
  PaymentStatus,
} from '../payments/entities/payment-transaction.entity';
import { Rating } from '../ratings/entities/rating.entity';
import {
  UserReport,
  ReportReason,
  ReportStatus,
} from '../safety/entities/user-report.entity';
import { SupportTicket } from '../support/entities/support-ticket.entity';
import { AdminAnalyticsIndexes1780000114000 } from '../database/migrations/1780000114000-AdminAnalyticsIndexes';
import { exportCreatedPages } from './streaming-export';
import type { SpreadsheetDownload } from './spreadsheet';

const bin = process.env.AUDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'admin aggregates and lists on isolated PostgreSQL',
  () => {
    jest.setTimeout(120000);
    const cluster = new IsolatedPostgres(bin!);
    let db: DataSource,
      analytics: AdminAnalyticsService,
      admin: AdminService,
      safety: SafetyService,
      support: SupportService;
    let driver: User, passenger: User, unrated: User, trip: Trip;
    const range = { from: '2026-10-01', to: '2026-10-02' };
    const at = new Date('2026-10-01T12:00:00Z');
    beforeAll(async () => {
      db = await cluster.start();
      db.setOptions({ entities: typeOrmEntities });
      await (db as any).buildMetadatas();
      await db.query('CREATE EXTENSION IF NOT EXISTS postgis');
      await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      await db.synchronize();
      analytics = new AdminAnalyticsService(db);
      admin = Object.assign(Object.create(AdminService.prototype), {
        userRepository: db.getRepository(User),
        tripRepository: db.getRepository(Trip),
        maxPageLimit: 200,
        bookingRepository: db.getRepository(Booking),
        paymentRepository: db.getRepository(PaymentTransaction),
        kycDocumentRepository: db.getRepository(KycDocument),
        tripRequestRepository: db.getRepository(TripRequest),
        tripRequestsService: {
          findForAdminBatch: (ids: string[]) => db.getRepository(TripRequest).findBy({ id: In(ids) }),
          findOne: (id: string) =>
            db.getRepository(TripRequest).findOneBy({ id }),
        },
        logger: { debug: jest.fn() },
      });
      safety = Object.assign(Object.create(SafetyService.prototype), {
        userReportRepository: db.getRepository(UserReport),
      });
      support = Object.assign(Object.create(SupportService.prototype), {
        ticketRepository: db.getRepository(SupportTicket),
      });
      driver = await db
        .getRepository(User)
        .save({
          firstName: 'Jean',
          lastName: 'Conducteur',
          role: UserRole.DRIVER,
          isDriver: true,
          phone: '+243999000001',
        });
      unrated = await db
        .getRepository(User)
        .save({
          firstName: 'Sans',
          lastName: 'Note',
          role: UserRole.DRIVER,
          isDriver: true,
        });
      passenger = await db
        .getRepository(User)
        .save({ firstName: 'Test', lastName: 'Passenger' });
      trip = await db
        .getRepository(Trip)
        .save({
          driverId: driver.id,
          departureLocation: 'Gombe',
          arrivalLocation: 'Limete',
          departureDate: at,
          createdAt: at,
          pricePerSeat: 1000,
          availableSeats: 3,
          status: TripStatus.COMPLETED,
        });
      await db.getRepository(Trip).save([
        {
          ...trip,
          id: randomUUID(),
          driverId: unrated.id,
          status: TripStatus.CANCELLED,
          createdAt: new Date('2026-10-02T23:59:59Z'),
        },
        {
          ...trip,
          id: randomUUID(),
          status: TripStatus.PENDING,
          createdAt: new Date('2026-10-03T00:00:00Z'),
        },
        {
          ...trip,
          id: randomUUID(),
          status: TripStatus.PENDING,
          createdAt: new Date('2026-09-29T00:00:00Z'),
        },
      ]);
      // >1000 records: SQL totals must not be capped by page size or multiply with ratings.
      await db.query(
        `INSERT INTO trips ("driverId","departureLocation","arrivalLocation","departureDate","pricePerSeat","availableSeats",status,"createdAt")
      SELECT $1,'Gombe','Limete',$2::timestamp,1000,3,'completed',$2::timestamp FROM generate_series(1,1100)`,
        [driver.id, at.toISOString()],
      );
      await db.getRepository(Rating).save([
        {
          tripId: trip.id,
          ratedUserId: driver.id,
          raterId: passenger.id,
          rating: 1,
          createdAt: at,
        },
        {
          tripId: trip.id,
          ratedUserId: driver.id,
          raterId: unrated.id,
          rating: 5,
          createdAt: at,
        },
        // Driver -> passenger rating must not inflate driver's mean.
        {
          tripId: trip.id,
          ratedUserId: passenger.id,
          raterId: driver.id,
          rating: 5,
          createdAt: at,
        },
      ]);
      for (const [status, currency, amount, purpose, operator] of [
        [PaymentStatus.SUCCEEDED, 'CDF', 1000, 'trip_booking', 'ORANGE_COD'],
        [PaymentStatus.FAILED, 'CDF', 2000, 'trip_booking', 'ORANGE_COD'],
        [PaymentStatus.SUCCEEDED, 'USD', 10, 'wallet_top_up', null],
        [PaymentStatus.PENDING, 'CDF', 3000, 'driver_payout', null],
        [PaymentStatus.INITIATED, 'CDF', 4000, 'referral_payout', null],
        [PaymentStatus.PENDING, 'CDF', 5000, 'wallet_top_up', null],
      ] as const)
        await db
          .getRepository(PaymentTransaction)
          .save({
            userId: passenger.id,
            method: PaymentMethod.MOBILE_MONEY,
            status,
            currency,
            amount,
            purpose,
            reference: `TEST-${randomUUID()}`,
            rawCheckResponse: operator ? { operator } : null,
            createdAt: at,
          });
      await db.getRepository(Booking).save([
        {
          tripId: trip.id,
          passengerId: passenger.id,
          numberOfSeats: 1,
          createdAt: at,
        },
        {
          tripId: trip.id,
          passengerId: unrated.id,
          numberOfSeats: 1,
          createdAt: new Date('2026-10-03'),
        },
      ]);
      await db
        .getRepository(TripRequest)
        .save({
          passengerId: passenger.id,
          departureLocation: 'A',
          arrivalLocation: 'B',
          departureDateMin: at,
          departureDateMax: at,
          numberOfSeats: 1,
          createdAt: at,
        });
      await db.getRepository(KycDocument).save([
        { userId: passenger.id, createdAt: at },
        { userId: driver.id, createdAt: at },
      ]);
      await db.getRepository(UserReport).save([
        {
          reporterId: passenger.id,
          reportedUserId: driver.id,
          reason: ReportReason.FRAUD,
          description: 'test',
          createdAt: at,
        },
        {
          reporterId: passenger.id,
          reportedUserId: driver.id,
          reason: ReportReason.SAFETY_CONCERN,
          status: ReportStatus.RESOLVED,
          description: 'test',
          createdAt: at,
        },
        {
          reporterId: passenger.id,
          reportedUserId: driver.id,
          reason: ReportReason.FRAUD,
          description: 'test',
          createdAt: new Date('2026-10-03'),
        },
      ]);
      await db
        .getRepository(SupportTicket)
        .save({
          userId: passenger.id,
          subject: 'Unique incident',
          createdAt: at,
        });
    });
    afterAll(() => cluster.stop(), 40000);

    it('computes full status counts, zero-filled days, previous period and actual driver ratings', async () => {
      const result = await analytics.overview({
        ...range,
        compare: 'previous',
      });
      expect(result.total).toBe(1102);
      expect(result.byStatus).toEqual({
        completed: 1101,
        cancelled: 1,
        ongoing: 0,
        upcoming: 0,
      });
      expect(result.daily).toEqual([
        { date: '2026-10-01', published: 1101, completed: 1101, cancelled: 0 },
        { date: '2026-10-02', published: 1, completed: 0, cancelled: 1 },
      ]);
      expect(
        result.drivers.find((d: any) => d.driverId === driver.id),
      ).toMatchObject({ total: 1101, averageRating: 3, ratingCount: 2 });
      expect(
        result.drivers.find((d: any) => d.driverId === unrated.id),
      ).toMatchObject({ averageRating: null, ratingCount: 0 });
      expect(result.previous).toMatchObject({
        total: 1,
        byStatus: { upcoming: 1 },
      });
      expect(result.popularRoutes[0].total).toBe(1102);
      expect(result.completionRate).toBeCloseTo((1101 / 1102) * 100);
    });
    it('returns real empty counts, null ratios and no invented rating', async () => {
      const result = await analytics.overview({
        from: '2020-01-01',
        to: '2020-01-02',
      });
      expect(result).toMatchObject({
        total: 0,
        completionRate: null,
        cancellationRate: null,
        drivers: [],
        previous: null,
      });
      expect(result.daily).toHaveLength(2);
      const ratings = await analytics.ratingsStats({
        from: '2020-01-01',
        to: '2020-01-02',
      });
      expect(ratings).toMatchObject({ total: 0, averageRating: null });
    expect(await analytics.paymentStats({ from: '2020-01-01', to: '2020-01-02' })).toMatchObject({
      total: 0, successRate: null, pendingPayouts: { count: 0, oldestCreatedAt: null, oldestAgeSeconds: null, averageAgeSeconds: null },
    });
    });
    it.each(['day', 'provider', 'operator'] as const)(
      'separates currencies and payout aging for grouping %s',
      async (groupBy) => {
        const result = await analytics.paymentStats({ ...range, groupBy });
        expect(result).toMatchObject({
          total: 6,
          succeeded: 2,
          failed: 1,
          pending: 3,
        });
        expect(result.successRate).toBeCloseTo(100 / 3);
        expect(result.volumes).toEqual(
          expect.arrayContaining([
            {
              currency: 'CDF',
              count: 5,
              requestedAmount: 15000,
              succeededAmount: 1000,
            },
            {
              currency: 'USD',
              count: 1,
              requestedAmount: 10,
              succeededAmount: 10,
            },
          ]),
        );
        expect(result.pendingPayouts.count).toBe(2);
        expect(result.pendingPayouts.oldestAgeSeconds).toBeGreaterThan(86400);
        expect(result.failuresByOperator).toEqual([
          {
            provider: 'flexpay',
            operator: 'ORANGE_COD',
            currency: 'CDF',
            count: 1,
            amount: 2000,
          },
        ]);
      },
    );
    it('uses database ratings and promotion activity without fictitious promotion codes', async () => {
      expect(await analytics.ratingsStats(range)).toMatchObject({
        total: 3,
        averageRating: 11 / 3,
      });
      expect(await analytics.promotionsStats(range)).toMatchObject({
        totalDrivers: 2,
        totalTrips: 1102,
        activeDriverCount: 2,
        avgTripsPerDriver: 551,
        promotionCodes: { available: false },
      });
    });
    it('searches all records before pagination and reports total even on an empty page', async () => {
      const page = await admin.getAllTrips(1, 1, {
        ...range,
        search: 'Jean Conducteur',
        status: 'completed',
        sort: 'createdAt:asc',
      });
      expect(page).toMatchObject({ total: 1101, page: 1, limit: 1 });
      expect(page.trips).toHaveLength(1);
      expect(
        await admin.getAllTrips(9999, 1, { ...range, search: 'Jean' }),
      ).toMatchObject({ total: 1101, trips: [] });
      expect(await admin.getAllTrips(1, 5, { search: '%' })).toMatchObject({
        total: 0,
      });
      expect(await admin.getAllTrips(1, 5, { search: trip.id })).toMatchObject({
        total: 1,
      });
    });
    it('applies dates and safe sorting to every admin list, with consistent payment summary', async () => {
      expect(
        await admin.getAllBookings(1, 10, undefined, {
          ...range,
          sort: 'numberOfSeats:asc',
        }),
      ).toMatchObject({ total: 1 });
      expect(
        await admin.getAllTripRequests(1, 10, undefined, range),
      ).toMatchObject({ total: 1 });
      expect(
        await admin.getKycDocuments(3, 1, 'pending', undefined, range),
      ).toMatchObject({ total: 2, documents: [], page: 3 });
      expect(
        await admin.getAllPayments(
          1,
          2,
          undefined,
          undefined,
          undefined,
          range,
        ),
      ).toMatchObject({ total: 6 });
      expect(
        await admin.getAllPayments(1, 2, undefined, undefined, undefined, {
          from: '2020-01-01',
          to: '2020-01-01',
        }),
      ).toMatchObject({ total: 0, summary: { total: 0 } });
      expect(
        await safety.listAdminUserReports({ ...range, page: 5, limit: 1 }),
      ).toMatchObject({ total: 2, reports: [] });
      expect(
        await support.listAdminTickets({ ...range, sort: 'subject:asc' }),
      ).toMatchObject({ total: 1, meta: { total: 1 } });
    });
    it('counts all reports by status and reason, respecting the end date', async () => {
      expect(await safety.adminReportStats(range)).toMatchObject({
        total: 2,
        byReason: { fraud: 1, safety_concern: 1 },
        byStatus: { pending: 1, resolved: 1 },
      });
    });
    it('global search returns bounded projections without credentials or provider payloads', async () => {
      const phone = await analytics.search('+243 999 000 001');
      expect(phone.users).toMatchObject({
        total: 1,
        items: [{ id: driver.id, phone: driver.phone }],
      });
      expect(JSON.stringify(phone)).not.toMatch(
        /accessToken|refreshToken|password|rawCheckResponse/,
      );
      expect((await analytics.search('TEST-')).payments.total).toBe(6);
      expect((await analytics.search(trip.id)).trips.total).toBe(1);
      expect((await analytics.search('Unique incident')).tickets.total).toBe(1);
      expect((await analytics.search("%' OR 1=1 --")).users.total).toBe(0);
    });
    it('exports all trips in bounded joined keyset pages, and preserves the small-download format', async () => {
      const text = async (file: SpreadsheetDownload) => {
        if ('buffer' in file) return file.buffer.toString('utf8');
        const chunks: Buffer[] = [];
        for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks).toString('utf8');
      };
      const file = await admin.exportTripsXls();
      expect('stream' in file).toBe(true);
      const xml = await text(file);
      const count = await db.getRepository(Trip).count();
      expect((xml.match(/<Row>/g) || [])).toHaveLength(count + 1);
      expect((xml.match(/<Workbook /g) || [])).toHaveLength(1);
      expect(xml).toContain(trip.id);
      for (const file of [await admin.exportBookingsXls(), await admin.exportTripRequestsXls(), await admin.exportPaymentsXls()]) {
        expect('buffer' in file).toBe(true);
        expect(await text(file)).toContain('</Workbook>');
      }
    });
    it('keeps microsecond cursor precision even after its boundary row is deleted', async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      try {
        for (let i = 0; i < ids.length; i++) await db.query(
          `INSERT INTO trips (id,"driverId","departureLocation","arrivalLocation","departureDate","pricePerSeat","availableSeats","createdAt")
           VALUES ($1,$2,'Export cursor','B',$3,1000,3,$3::timestamp)`,
          [ids[i], driver.id, `2026-10-01T12:00:00.00000${i + 1}`]);
        const pages = exportCreatedPages(db.getRepository(Trip).createQueryBuilder('trip')
          .leftJoinAndSelect('trip.driver', 'driver').where('trip.id IN (:...ids)', { ids }), 'trip');
        expect((await pages(0, 1)).map(row => row.id)).toEqual([ids[2]]);
        await db.getRepository(Trip).delete(ids[2]);
        expect((await pages(1, 1)).map(row => row.id)).toEqual([ids[1]]);
        expect((await pages(2, 1)).map(row => row.id)).toEqual([ids[0]]);
        expect(await pages(3, 1)).toEqual([]);
      } finally { await db.getRepository(Trip).delete(ids); }
    });
    it('adds valid reversible indexes without modifying business data', async () => {
      const runner = db.createQueryRunner(),
        migration = new AdminAnalyticsIndexes1780000114000();
      try {
        await migration.up(runner);
        await migration.up(runner);
        expect(
          (
            await db.query(
              `SELECT count(*)::int AS count FROM pg_indexes WHERE indexname LIKE 'IDX_admin_%'`,
            )
          )[0].count,
        ).toBe(10);
        await migration.down(runner);
        expect((await analytics.overview(range)).total).toBe(1102);
      } finally {
        await runner.release();
      }
    });
    it('executes the non-transactional online migration through TypeORM each mode', async () => {
      const previous = db.migrations.slice();
      db.migrations.splice(0, db.migrations.length, new AdminAnalyticsIndexes1780000114000());
      try {
        const applied = await db.runMigrations({ transaction: 'each' });
        expect(applied.map(item => item.name)).toEqual(['AdminAnalyticsIndexes1780000114000']);
        expect(await db.runMigrations({ transaction: 'each' })).toEqual([]);
        await db.undoLastMigration({ transaction: 'each' });
        expect((await analytics.overview(range)).total).toBe(1102);
      } finally { db.migrations.splice(0, db.migrations.length, ...previous); }
    });
  },
);
