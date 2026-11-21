import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { User } from '../users/entities/user.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { Booking, BookingPaymentStatus, BookingStatus } from '../bookings/entities/booking.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { WalletAccount, WalletAccountType } from '../wallet/entities/wallet-account.entity';
import { WalletLedgerEntry, WalletLedgerEntryType } from '../wallet/entities/wallet-ledger-entry.entity';
import { scanFinancialIntegrity } from '../wallet/financial-integrity-scan';
import { WALLET_BALANCE_MISMATCH_SQL } from '../wallet/wallet-integrity';
import { AdminService } from './admin.service';
import { AdminUserHistoryKind } from './dto/user-history.dto';
import { userHistoryStats } from './user-history-stats';
import { AdminReferralsService } from './admin-referrals.service';
import { ReferralAccount } from '../referrals/entities/referral-account.entity';
import { ReferralProfile } from '../referrals/entities/referral-profile.entity';
import { ReferralReward } from '../referrals/entities/referral-reward.entity';
import { ReferralWithdrawal } from '../referrals/entities/referral-withdrawal.entity';
import { PaymentTransaction, PaymentMethod, PaymentStatus } from '../payments/entities/payment-transaction.entity';
import { TripRequest, TripRequestStatus } from '../trip-requests/entities/trip-request.entity';
import { DriverOffer } from '../trip-requests/entities/driver-offer.entity';
import { requestProfileStats } from '../trip-requests/request-profile-stats';
import { requestDiscoveryIds } from '../trip-requests/request-pages';
import { nearbyRequestDriverVisibilitySql, latestDriverPositionSql } from '../trip-requests/request-proximity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { PartnersService } from '../partners/partners.service';
import { PartnerOrganization, PartnerMember, PartnerFieldLead, PartnerFieldTarget, PartnerFieldTicket } from '../partners/partner.entities';
import { DiscoveryGeographyIndex1780000136000 } from '../database/migrations/1780000136000-DiscoveryGeographyIndex';

const bin = process.env.PERFORMANCE_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('remaining performance fixes on disposable PostgreSQL', () => {
  jest.setTimeout(120000);
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource;
  beforeAll(async () => {
    db = await cluster.start(); db.setOptions({ entities: typeOrmEntities });
    await (db as any).buildMetadatas();
    await db.query('CREATE EXTENSION postgis; CREATE EXTENSION "uuid-ossp"');
    await db.synchronize();
    await db.query(`CREATE TABLE driver_dispatch_presence ("driverId" uuid PRIMARY KEY, position geography(Point,4326), "updatedAt" timestamptz, "expiresAt" timestamptz, "discoveryEnabled" boolean);
      CREATE TABLE trip_request_driver_refusals ("requestId" uuid, "driverId" uuid)`);
  });
  afterAll(() => cluster.stop());
  beforeEach(() => db.query('TRUNCATE users,wallet_accounts,payment_transactions,partner_organizations,driver_dispatch_presence,trip_request_driver_refusals CASCADE'));
  const user = () => db.getRepository(User).save({ firstName: 'Synthetic', lastName: 'Test' });

  it('computes mobile request counts without hydrating or expiring history as a side effect', async () => {
    const owner = await user(), driver = await user();
    const make = (status: TripRequestStatus, hours = 1) => db.getRepository(TripRequest).save({ passengerId: owner.id,
      departureLocation: 'A', arrivalLocation: 'B', departureDateMin: new Date(), departureDateMax: new Date(Date.now() + hours * 3600000), numberOfSeats: 1, status });
    await make(TripRequestStatus.PENDING); await make(TripRequestStatus.PENDING, -4);
    const offered = await make(TripRequestStatus.OFFERS_RECEIVED);
    await db.getRepository(DriverOffer).save({ tripRequestId: offered.id, driverId: driver.id, proposedDepartureDate: new Date(), pricePerSeat: 2500, availableSeats: 2 });
    await make(TripRequestStatus.DRIVER_SELECTED); await make(TripRequestStatus.DRIVER_SELECTED, -4);
    expect(await requestProfileStats(db.manager, owner.id)).toEqual({ totalRequests: 5, activeRequests: 2, requestsWithOffers: 1, completedRequests: 1, pendingOffersCount: 0 });
    expect(await requestProfileStats(db.manager, driver.id)).toMatchObject({ totalRequests: 0, pendingOffersCount: 1 });
    expect(await db.getRepository(TripRequest).countBy({ status: TripRequestStatus.EXPIRED })).toBe(0);
  });

  it('orders the complete visible request set before taking a discovery page', async () => {
    const owner = await user(), driver = await user();
    await db.getRepository(Vehicle).save({ ownerId: driver.id, brand: 'Test', model: 'Test', color: 'Test', licensePlate: randomUUID() });
    await db.query(`INSERT INTO driver_dispatch_presence VALUES($1,ST_SetSRID(ST_MakePoint(15.3,-4.3),4326),now(),now()+interval '1 hour',true)`, [driver.id]);
    const requests: TripRequest[] = [];
    for (let i = 0; i < 5; i++) requests.push(await db.getRepository(TripRequest).save({ passengerId: owner.id,
      departureLocation: 'École Gombe', arrivalLocation: 'Ngaliema', departurePoint: { type: 'Point', coordinates: [15.3 + i * 0.001, -4.3] },
      departureDateMin: new Date(Date.now() + (5 - i) * 60000), departureDateMax: new Date(Date.now() + 3600000), numberOfSeats: 2, maxPricePerSeat: 3000 + 1000 * i }));
    await db.query('INSERT INTO trip_request_driver_refusals VALUES ($1,$2)', [requests[4].id, driver.id]);
    const repo = db.getRepository(TripRequest);
    const visibility = await db.query(`SELECT r.id, ${nearbyRequestDriverVisibilitySql('r.id', '$1')} AS visible,
      ST_DWithin(r."departurePoint",${latestDriverPositionSql('$1')},5000) AS nearby,
      translate(lower(r."departureLocation"),'Éé','ee') AS name FROM trip_requests r ORDER BY r."maxPricePerSeat"`, [driver.id]);
    expect(visibility.map(row => ({ visible: row.visible, nearby: row.nearby, name: row.name }))).toEqual([
      ...Array.from({ length: 4 }, () => ({ visible: true, nearby: true, name: 'ecole gombe' })), { visible: false, nearby: true, name: 'ecole gombe' },
    ]);
    expect((await requestDiscoveryIds(repo, driver.id, {})).total).toBe(4);
    expect(await requestDiscoveryIds(repo, driver.id, { sort: 'cheap', limit: 2, search: 'ecole', minSeats: 2 })).toMatchObject({ total: 4, hasMore: true, ids: [requests[3].id, requests[2].id] });
    expect((await requestDiscoveryIds(repo, driver.id, { sort: 'cheap', limit: 2, page: 2 })).ids).toEqual([requests[1].id, requests[0].id]);
    expect((await requestDiscoveryIds(repo, driver.id, { sort: 'nearby', limit: 2 })).ids).toEqual([requests[0].id, requests[1].id]);
    expect((await requestDiscoveryIds(repo, driver.id, { minSeats: 3 })).total).toBe(0);
    await db.query('UPDATE driver_dispatch_presence SET "discoveryEnabled"=false');
    expect((await requestDiscoveryIds(repo, driver.id, {})).ids).toEqual([]);
  });

  it('paginates partner leads across 200 rows and keeps exact, scoped summaries', async () => {
    const agent = await user(), supervisor = await user(), stranger = await user();
    const org = await db.getRepository(PartnerOrganization).save({ displayName: 'Synthetic', legalType: 'COMPANY', status: 'ACTIVE', partnerTypes: [{ type: 'FIELD_MARKETING', status: 'ACTIVE' }] });
    await db.getRepository(PartnerMember).save([{ organizationId: org.id, userId: agent.id, role: 'FIELD_AGENT' }, { organizationId: org.id, userId: supervisor.id, role: 'FIELD_SUPERVISOR' }]);
    await db.query(`INSERT INTO partner_field_leads("organizationId","agentId","firstName","lastName",phone,city,"createdAt")
      SELECT $1,CASE WHEN n<=201 THEN $2::uuid ELSE $3::uuid END,'École','Synthetic','+2438'||lpad(n::text,8,'0'),'Kinshasa',timestamp '2026-01-01'+n*interval '1 microsecond' FROM generate_series(1,203)n`, [org.id, agent.id, supervisor.id]);
    const service = new PartnersService(db.getRepository(PartnerOrganization), db.getRepository(PartnerMember), db.getRepository(PartnerFieldLead),
      db.getRepository(PartnerFieldTarget), db.getRepository(PartnerFieldTicket), db.getRepository(User), db.getRepository(Trip), {} as any);
    const projection = jest.spyOn(service as any, 'leadProgress');
    const mine = await service.overview(agent.id, org.id, 'summary');
    expect(mine.leads).toEqual([]); expect(mine.summary).toMatchObject({ total: 201, mine: { stages: { contacted: 201 } } });
    expect(projection.mock.calls.map(call => (call[0] as any[]).length)).toEqual([200, 1]);
    const team = await service.overview(supervisor.id, org.id, 'summary');
    expect(team.summary).toMatchObject({ total: 203, mine: { stages: { contacted: 2 } } });
    const page = await service.fieldLeadsPage(agent.id, org.id, { page: 9, limit: 25, search: 'ecole' });
    expect(page.total).toBe(201); expect(page.items).toHaveLength(1); expect(page.items[0].agentId).toBe(agent.id);
    const number = await service.fieldLeadsPage(agent.id, org.id, { search: '0800000001' });
    expect(number.total).toBe(1);
    const supervisorLead = await db.getRepository(PartnerFieldLead).findOneByOrFail({ agentId: supervisor.id });
    expect((await service.fieldLeadsPage(agent.id, org.id, { id: supervisorLead.id })).items).toEqual([]);
    await expect(service.overview(stranger.id, org.id, 'summary')).rejects.toThrow('Accès refusé');
    await expect(service.fieldLeadsPage(stranger.id, org.id)).rejects.toThrow('Accès refusé');
  });

  it('audits old and recent accounts across pages without rewriting any financial data', async () => {
    const owner = await user();
    // Several users: one account per user/type constraint remains enforced.
    for (let i=0;i<5;i++) {
      const u = i ? await user() : owner;
      const account = await db.getRepository(WalletAccount).save({ userId: u.id, type: WalletAccountType.POINTS, balance: 100 });
      await db.getRepository(WalletLedgerEntry).save({ accountId: account.id, userId: u.id,
        accountType: WalletAccountType.POINTS, type: WalletLedgerEntryType.TOP_UP,
        amount: i===4 ? 90 : 100, balanceAfter: 100 });
    }
    const trip = await db.getRepository(Trip).save({ driverId: owner.id, departureLocation:'A', arrivalLocation:'B',
      departureDate: new Date(), availableSeats: 2, pricePerSeat: 2500, status: TripStatus.COMPLETED });
    await db.getRepository(Booking).save({ tripId: trip.id, passengerId: owner.id, numberOfSeats:1,
      status: BookingStatus.COMPLETED, paymentMode:TripPaymentMode.POINTS, paymentStatus: BookingPaymentStatus.SUCCEEDED });
    const before = await db.getRepository(WalletAccount).find({ order: { id:'ASC' } });
    const result = await scanFinancialIntegrity(db, () => {}, 2);
    const [reference] = await db.query(WALLET_BALANCE_MISMATCH_SQL);
    expect(result).toEqual({ unsafeAnomalies:1, walletBalanceMismatches: Number(reference.count) });
    expect(result.walletBalanceMismatches).toBe(1);
    expect(await db.getRepository(WalletAccount).find({ order: { id:'ASC' } })).toEqual(before);
  });

  it('returns exact totals and isolated cursor pages for admin user histories', async () => {
    const owner = await user(), stranger = await user();
    const service = Object.assign(Object.create(AdminService.prototype), {
      userRepository: db.getRepository(User), paymentRepository: db.getRepository(PaymentTransaction),
      tripRepository: db.getRepository(Trip), bookingRepository: db.getRepository(Booking),
      tripRequestRepository: db.getRepository(TripRequest), sanitizePayment: (p: PaymentTransaction) => ({ id:p.id, userId:p.userId }),
    });
    const ids: string[]=[];
    for(let i=0;i<5;i++) {
      const payment = await db.getRepository(PaymentTransaction).save({ userId:owner.id, reference:randomUUID(),
        method:PaymentMethod.MOBILE_MONEY, status:PaymentStatus.SUCCEEDED, amount:100, currency:'CDF' });
      ids.push(payment.id);
      await db.query(`UPDATE payment_transactions SET "createdAt"=$2::timestamp WHERE id=$1`, [payment.id, `2026-01-01T00:00:00.00000${i+1}`]);
    }
    await db.getRepository(PaymentTransaction).save({ userId:stranger.id, reference:randomUUID(), method:PaymentMethod.MOBILE_MONEY, amount:999, currency:'CDF' });
    expect(await userHistoryStats(db.manager, owner.id)).toMatchObject({ payments:5,succeededPaymentsAmount:500 });
    let before: string|undefined, all: string[]=[];
    do {
      const page = await service.getUserHistory(owner.id, AdminUserHistoryKind.PAYMENTS, { limit:2, before });
      expect(page.total).toBe(5); expect(page.data.length).toBeLessThanOrEqual(2);
      all.push(...page.data.map((p: any) => p.id)); before=page.nextCursor ?? undefined;
      if (before) await expect(service.getUserHistory(stranger.id, AdminUserHistoryKind.PAYMENTS, { limit:2,before })).rejects.toThrow();
    } while (before);
    expect(all).toEqual(ids.reverse());
  });

  it('streams referral withdrawals across the 500-row boundary in requestedAt order', async () => {
    const owner = await user();
    await db.query(`INSERT INTO referral_withdrawals("userId",tokens,amount,"moneyPerToken",phone,"requestedAt")
      SELECT $1,10,100,10,'synthetic',timestamp '2026-01-01'+n*interval '1 microsecond' FROM generate_series(1,503)n`, [owner.id]);
    const service = new AdminReferralsService(db.getRepository(User), db.getRepository(ReferralAccount), db.getRepository(ReferralProfile),
      db.getRepository(ReferralReward), db.getRepository(ReferralWithdrawal), {} as any);
    const file = await service.exportWithdrawals();
    expect('stream' in file).toBe(true);
    if (!('stream' in file)) throw Error('expected stream');
    const chunks: Buffer[]=[];
    for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
    const xml=Buffer.concat(chunks).toString('utf8');
    expect(xml.match(/<Row>/g)).toHaveLength(504);
    const rows=await db.getRepository(ReferralWithdrawal).find({ order:{requestedAt:'DESC',id:'DESC'} });
    let position=-1;
    for(const row of rows) { const next=xml.indexOf(row.id); expect(next).toBeGreaterThan(position); position=next; }
  });

  it('builds the spatial index concurrently, can be rerun, and restores session budgets', async () => {
    const q=db.createQueryRunner(), migration=new DiscoveryGeographyIndex1780000136000();
    try {
      await q.connect();
      const previous=await q.query('SHOW statement_timeout');
      await migration.down(q); await migration.up(q); await migration.up(q);
      expect(await q.query('SHOW statement_timeout')).toEqual(previous);
      const [row]=await q.query(`SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass('"IDX_trips_current_location"')`);
      expect(row.indisvalid).toBe(true);
    } finally { await q.release(); }
  });
});
