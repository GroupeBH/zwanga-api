import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IsolatedPostgres } from '../../../test/isolated-postgres';
import { proFixture } from '../../../test/pro-credit-fixture';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CREDIT_COST_VERSION,
  creditSchedule,
} from '../../asset-credit/credit-cost';
import { CreditStore, CreditActor } from '../shared/credit.store';
import {
  CreditCollectionsService,
  CollectionDebtor,
  RecoveryHistoryItem,
} from '../collections/credit-collections.service';
import { CreditCollectionsController } from '../collections/credit-collections.controller';
import { COLLECTION_BALANCES_CTE } from '../collections/collection-balances.sql';
import { CreditContractsController } from '../contracts/credit-contracts.controller';
import { CreditContractsService } from '../contracts/credit-contracts.service';
import { CreditCatalogService } from '../catalogue/credit-catalogue.service';
import { CreditEligibilityService } from '../eligibility/credit-eligibility.service';
import { CreditReportingController } from '../reporting/credit-reporting.controller';
import { CreditReportingService } from '../reporting/credit-reporting.service';
import { CreditSchedulesService } from '../schedules/credit-schedules.service';

interface Page<T> {
  items: T[];
  nextCursor: string | null;
  asOf: string;
}
interface ContractView {
  id: string;
  driverId?: string;
  debtor?: { firstName: string; lastName: string; phone: string };
  overdueMinor?: string;
  overdueDays?: number;
}
interface Receipt {
  id: string;
  creditId: string;
  createdAt: string;
}
const json = <T>(response: request.Response) => response.body as T;
const day = 86400000;
const bin = process.env.PRO_CREDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'Collections: isolated PostgreSQL and Nest HTTP',
  () => {
    const pg = new IsolatedPostgres(bin!);
    let db: DataSource, app: INestApplication, url: string, store: CreditStore;
    let admin: CreditActor,
      debtor: CreditActor,
      collector: CreditActor,
      funder: CreditActor,
      analyst: CreditActor;
    let party: string, product: string;
    const identities = new Map<string, CreditActor>();
    const past = (days: number) =>
      new Date(Date.now() - days * day).toISOString();
    async function user(role = 'driver', grant?: string) {
      const id = randomUUID();
      await db.query(
        "INSERT INTO users(id,role,\"firstName\",\"lastName\",phone) VALUES($1,$2,'Aline','Exemple','+243000000001')",
        [id, role],
      );
      const actor = { userId: id, role };
      identities.set(id, actor);
      if (grant)
        await db.query(
          'INSERT INTO pro_credit_grants("userId",role,"grantedBy","organizationId") VALUES($1,$2,$3,$4)',
          [id, grant, admin.userId, grant === 'funder' ? party : null],
        );
      return actor;
    }
    beforeAll(async () => {
      db = await pg.start();
      await proFixture(db);
      store = new CreditStore(db);
      const module = await Test.createTestingModule({
        controllers: [
          CreditCollectionsController,
          CreditContractsController,
          CreditReportingController,
        ],
        providers: [
          {
            provide: CreditCollectionsService,
            useValue: new CreditCollectionsService(store),
          },
          {
            provide: CreditContractsService,
            useValue: new CreditContractsService(
              store,
              new CreditCatalogService(store),
              new CreditEligibilityService(store),
            ),
          },
          {
            provide: CreditReportingService,
            useValue: new CreditReportingService(store),
          },
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue({
          canActivate(context: ExecutionContext) {
            const req = context.switchToHttp().getRequest<{
              headers: Record<string, string>;
              user: CreditActor;
            }>();
            const actor = identities.get(req.headers['x-test-actor']);
            if (!actor) throw new UnauthorizedException();
            req.user = actor;
            return true;
          },
        })
        .compile();
      app = module.createNestApplication();
      app.useGlobalPipes(
        new ValidationPipe({
          transform: true,
          whitelist: true,
          forbidNonWhitelisted: true,
        }),
      );
      await app.listen(0, '127.0.0.1');
      url = await app.getUrl();
    }, 90000);
    afterAll(async () => {
      if (app) await app.close();
      await pg.stop();
    }, 45000);
    beforeEach(async () => {
      await db.query('TRUNCATE users CASCADE');
      await db.query('TRUNCATE notifications');
      identities.clear();
      admin = await user('super_admin');
      debtor = await user();
      collector = await user('driver', 'collector');
      analyst = await user('driver', 'analyst');
      party = randomUUID();
      product = randomUUID();
      const policy = randomUUID();
      await db.query('INSERT INTO partner_organizations(id) VALUES($1)', [
        party,
      ]);
      await db.query(
        'INSERT INTO pro_credit_parties("organizationId",supplier,funder,operator,"authorizationReference","validatedBy") VALUES($1,true,true,true,\'LOCAL-TEST\',$2)',
        [party, admin.userId],
      );
      await db.query(
        "INSERT INTO pro_credit_policies(id,version,terms,\"legalReference\",rules,\"createdBy\") VALUES($1,'test','Conditions fictives','TEST','{}',$2)",
        [policy, admin.userId],
      );
      await db.query(
        'INSERT INTO pro_credit_products(id,code,kind,name,description,currency,"supplierId","sellerId","creditorId","policyId","financingModel","priceMinor","feeMinor",details) VALUES($1,\'test\',\'phone\',\'Téléphone test\',\'Fictif\',\'CDF\',$2,$2,$2,$3,\'ZWANGA_DIRECT\',10000,0,\'{}\')',
        [product, party, policy],
      );
      funder = await user('driver', 'funder');
      await db.query(
        'INSERT INTO partner_members("userId","organizationId") VALUES($1,$2)',
        [funder.userId, party],
      );
    });
    async function credit(
      options: {
        catalogue?: boolean;
        owner?: string;
        total?: string;
        paid?: string;
        origin?: string;
        count?: number;
        period?: 'week' | 'month';
        status?: string;
        disclosed?: boolean;
        version?: number;
        baseline?: string;
        due?: { amount: string; at: string }[];
      } = {},
    ) {
      const id = randomUUID(),
        owner = options.owner ?? debtor.userId,
        total = options.total ?? '10000',
        paid = options.paid ?? '0';
      const origin = options.origin ?? past(36),
        count = options.count ?? 4,
        period = options.period ?? 'week';
      const disclosed = options.disclosed !== false && !options.catalogue;
      await db.transaction(async (m) => {
        await m.query(
          `INSERT INTO asset_credits(id,"driverId","assetKind",label,"principalMinor","paidMinor",status,terms,"policyVersion","validationReference","deliveryReference","assetReference","createdBy","mutationId","requestPayload","acceptedAt","activatedAt",
        "cashPriceMinor","creditFeeMinor","installmentCount","installmentPeriod","costDisclosureVersion")
        VALUES($1::uuid,$2,'phone',$3,$4,$5,$6,'Conditions de test',$7,'TEST','TEST',$1::uuid::text,$8,$9,'{}',$10,$10,$11,$12,$13,$14,$15)`,
          [
            id,
            owner,
            options.catalogue ? 'Catalogue test' : 'Offre équipe test',
            total,
            paid,
            options.status ?? 'active',
            options.catalogue ? 'zwanga-pro-v1' : 'asset-credit-v2',
            admin.userId,
            randomUUID(),
            origin,
            disclosed ? total : null,
            disclosed ? 0 : null,
            disclosed ? count : null,
            disclosed ? period : null,
            disclosed ? CREDIT_COST_VERSION : null,
          ],
        );
        if (options.catalogue) {
          const req = randomUUID();
          await m.query(
            'INSERT INTO asset_credit_requests(id,"driverId","assetKind",status) VALUES($1,$2,\'phone\',\'offered\')',
            [req, owner],
          );
          await m.query(
            `INSERT INTO pro_credit_contracts("creditId","requestId","productId","creditorId",snapshot,"termsHash",evaluation,"depositMinor","scheduleVersion","scheduleBaselineMinor")
          VALUES($1,$2,$3,$4,$5,'test','{}',0,$6,$7)`,
            [
              id,
              req,
              product,
              party,
              JSON.stringify({
                product: { kind: 'phone' },
                policy: { rules: { maxInstallments: 12 } },
              }),
              options.version ?? 1,
              options.baseline ?? '0',
            ],
          );
          for (const [index, i] of (
            options.due ?? [{ amount: total, at: past(10) }]
          ).entries())
            await m.query(
              'INSERT INTO pro_credit_installments VALUES($1,$2,$3,$4,$5)',
              [id, options.version ?? 1, index + 1, i.at, i.amount],
            );
        }
        if (BigInt(paid) > 0n)
          await m.query(
            'INSERT INTO asset_credit_entries("creditId","driverId",kind,"amountMinor","sourceKey") VALUES($1,$2,\'wallet\',$3,$4)',
            [id, owner, paid, randomUUID()],
          );
      });
      return {
        id,
        driverId: owner,
        costDisclosureVersion: disclosed ? CREDIT_COST_VERSION : null,
        principalMinor: total,
        paidMinor: paid,
        activatedAt: origin,
        installmentCount: disclosed ? count : null,
        installmentPeriod: disclosed ? period : null,
      };
    }
    const actionPath = (id: string) =>
      `/zwanga-pro/admin/credits/${id}/recovery-actions`;
    const action = (extra: Record<string, unknown> = {}) => ({
      mutationId: randomUUID(),
      kind: 'call',
      outcome: 'reached',
      note: 'Échange fictif de test',
      ...extra,
    });
    const post = (id: string, data: unknown, actor = collector) =>
      request(url)
        .post(actionPath(id))
        .set('x-test-actor', actor.userId)
        .send(data as object);
    const get = (path: string, actor = collector) =>
      request(url).get(path).set('x-test-actor', actor.userId);

    it('requires identity and persisted grants; funder and plain admin cannot recover or read personal data', async () => {
      const c = await credit(),
        plainAdmin = await user('admin');
      await request(url)
        .get('/zwanga-pro/admin/collections/debtors')
        .expect(401);
      for (const actor of [debtor, funder, plainAdmin]) {
        await post(c.id, action(), actor).expect(403);
        await get(actionPath(c.id), actor).expect(403);
        const denied = await get(
          '/zwanga-pro/admin/collections/debtors',
          actor,
        ).expect(403);
        expect(JSON.stringify(denied.body)).not.toContain('+243');
      }
    });
    it('refuses self recovery, unknown credit and non-active credit', async () => {
      const own = await credit({ owner: collector.userId });
      await post(own.id, action()).expect(409);
      await post(randomUUID(), action()).expect(404);
      for (const status of [
        'offered',
        'accepted',
        'declined',
        'cancelled',
        'settled',
      ]) {
        const c = await credit({
          status,
          paid: status === 'settled' ? '10000' : '0',
        });
        await post(c.id, action()).expect(409);
      }
    });
    it.each([false, true])(
      'audits either source (catalogue=%s), concurrent retries once, conflicts on changed content, no money or notifications',
      async (catalogue) => {
        const c = await credit({ catalogue }),
          dto = action({ outcome: 'paid' });
        const before = await db.query<Record<string, unknown>[]>(
          'SELECT * FROM asset_credits WHERE id=$1',
          [c.id],
        );
        const financeBefore = await db.query<Record<string, unknown>[]>(
          `SELECT (SELECT count(*) FROM asset_credit_entries) AS entries,
          (SELECT count(*) FROM pro_credit_journals) AS journals`,
        );
        const [a, b] = await Promise.all([
          post(c.id, dto).expect(201),
          post(c.id, dto).expect(201),
        ]);
        expect(json<Receipt>(a)).toEqual(json<Receipt>(b));
        expect(json<Receipt>(a).creditId).toBe(c.id);
        expect(
          await db.query('SELECT * FROM asset_credits WHERE id=$1', [c.id]),
        ).toEqual(before);
        const [{ count }] = await db.query<{ count: string }[]>(
          'SELECT count(*) FROM pro_credit_audit WHERE "creditId"=$1',
          [c.id],
        );
        expect(count).toBe('1');
        expect(await db.query('SELECT * FROM notifications')).toEqual([]);
        expect(
          await db.query(`SELECT (SELECT count(*) FROM asset_credit_entries) AS entries,
          (SELECT count(*) FROM pro_credit_journals) AS journals`),
        ).toEqual(financeBefore);
        await post(c.id, { ...dto, note: 'Contenu différent' }).expect(409);
        await db.query(
          'UPDATE pro_credit_grants SET enabled=false WHERE "userId"=$1',
          [collector.userId],
        );
        await post(c.id, dto).expect(403);
      },
    );
    it.each([
      {},
      { promisedAt: past(-1) },
      { promisedAmountMinor: '100' },
      { promisedAt: past(1), promisedAmountMinor: '100' },
      { promisedAt: past(-91), promisedAmountMinor: '100' },
      { promisedAt: past(-1), promisedAmountMinor: '0' },
      { promisedAt: past(-1), promisedAmountMinor: '7501' },
      { promisedAt: past(-1), promisedAmountMinor: 100 },
      { promisedAt: past(-1), promisedAmountMinor: '1.5' },
      { promisedAt: '2026-02-30T12:00:00Z', promisedAmountMinor: '100' },
    ])('rejects invalid promise %j', async (fields) => {
      const c = await credit({ paid: '2500' });
      await post(c.id, action({ outcome: 'promise_to_pay', ...fields })).expect(
        400,
      );
    });
    it('accepts a future promise up to the outstanding cents, normalizes UTC, and refuses promise data for other outcomes', async () => {
      const c = await credit({ paid: '2500' });
      await post(
        c.id,
        action({
          outcome: 'promise_to_pay',
          promisedAt: past(-1),
          promisedAmountMinor: '7500',
        }),
      ).expect(201);
      const h = json<Page<RecoveryHistoryItem>>(
        await get(actionPath(c.id)).expect(200),
      );
      expect(h.items[0].detail.promisedAmountMinor).toBe('7500');
      expect(h.items[0].detail.promisedAt).toMatch(/Z$/);
      for (const fields of [
        { promisedAt: past(-1) },
        { promisedAmountMinor: '100' },
        { promisedAt: null },
      ])
        await post(c.id, action(fields)).expect(400);
      await post(c.id, action({ note: '   ' })).expect(400);
      await post(c.id, action({ note: 'x'.repeat(1001) })).expect(400);
      await post(c.id, action({ kind: 'invalid' })).expect(400);
      await post(c.id, action({ outcome: 'invalid' })).expect(400);
    });
    it('history paginates timestamp+UUID ties and microseconds, includes schedule events, returns null actors and no-store', async () => {
      const c = await credit();
      const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
      for (const [index, id] of ids.entries())
        await db.query(
          'INSERT INTO pro_credit_audit(id,"creditId","actorId",action,detail,"createdAt") VALUES($1,$2,$3,$4,\'{}\',$5)',
          [
            id,
            c.id,
            index === 2 ? null : collector.userId,
            index === 0 ? 'reschedule_approved' : 'recovery_action',
            index === 2
              ? '2026-01-01T00:00:00.123457Z'
              : '2026-01-01T00:00:00.123456Z',
          ],
        );
      await store.audit(db.manager, admin.userId, 'excluded_event', {}, c.id);
      const first = await get(`${actionPath(c.id)}?limit=1`, analyst)
        .expect(200)
        .expect('Cache-Control', 'no-store');
      const one = json<Page<RecoveryHistoryItem>>(first);
      expect(one.items[0]).toMatchObject({ id: ids[2], actor: null });
      const two = json<Page<RecoveryHistoryItem>>(
        await get(`${actionPath(c.id)}?limit=1&after=${one.nextCursor}`).expect(
          200,
        ),
      );
      expect(two.items[0].id).toBe(ids[1]);
      const three = json<Page<RecoveryHistoryItem>>(
        await get(`${actionPath(c.id)}?limit=1&after=${two.nextCursor}`).expect(
          200,
        ),
      );
      expect(three.items[0]).toMatchObject({
        id: ids[0],
        action: 'reschedule_approved',
        actor: { firstName: 'Aline', lastName: 'Exemple' },
      });
      expect(three.nextCursor).toBeNull();
      const other = await credit();
      await get(`${actionPath(other.id)}?after=${one.nextCursor}`).expect(400);
    });
    it('combines both sources, uses the current baseline/version, and includes the latest action across all debtor credits', async () => {
      const team = await credit({ paid: '2500' });
      const pro = await credit({
        catalogue: true,
        paid: '5000',
        baseline: '4000',
        version: 2,
        due: [
          { amount: '2000', at: past(10) },
          { amount: '2000', at: past(3) },
          { amount: '2000', at: past(-7) },
        ],
      });
      await db.query(
        'INSERT INTO pro_credit_installments VALUES($1,1,1,$2,10000)',
        [pro.id, past(100)],
      );
      await post(
        pro.id,
        action({
          outcome: 'promise_to_pay',
          promisedAt: past(-2),
          promisedAmountMinor: '5000',
        }),
      ).expect(201);
      const response = await get('/zwanga-pro/admin/collections/debtors')
        .expect(200)
        .expect('Cache-Control', 'no-store');
      const result = json<Page<CollectionDebtor>>(response),
        item = result.items[0];
      expect(result.items).toHaveLength(1);
      expect(item).toMatchObject({
        driverId: debtor.userId,
        lateMinor: '10500',
        daysLate: 22,
        phone: '+243000000001',
        accountStatus: 'active',
        lastAction: { promisedAmountMinor: '5000' },
      });
      expect(item.contracts.find((c) => c.id === team.id)?.lateMinor).toBe(
        String(creditSchedule(team, new Date(result.asOf)).minimumDueMinor),
      );
      expect(item.contracts.find((c) => c.id === pro.id)).toMatchObject({
        source: 'catalogue',
        lateMinor: '3000',
        remainingMinor: '5000',
        daysLate: 10,
        kind: 'phone',
      });
      const detail = json<ContractView>(
        await get(`/zwanga-pro/admin/contracts/${pro.id}`).expect(200),
      );
      expect(detail).toMatchObject({
        driverId: debtor.userId,
        overdueMinor: '3000',
        overdueDays: 10,
      });
      const overview = json<{
        overdue: { id: string; lateMinor: string; overdueDays: number }[];
      }>(await get('/zwanga-pro/admin/overview').expect(200));
      expect(overview.overdue.find((c) => c.id === pro.id)).toMatchObject({
        lateMinor: '3000',
        overdueDays: 10,
      });
    });
    it('uses the new baseline after actual proposal, debtor consent and distinct approval', async () => {
      const c = await credit({ catalogue: true, paid: '2500' });
      await db.query(
        'UPDATE pro_credit_contracts SET "mandateUntil"=$2 WHERE "creditId"=$1',
        [c.id, past(-90)],
      );
      const schedules = new CreditSchedulesService(store);
      const proposal = await schedules.propose(collector, c.id, {
        mutationId: randomUUID(),
        installments: 2,
        period: 'week',
        reason: 'Accord de test pour deux échéances',
      });
      await schedules.reschedule(debtor, proposal.id, randomUUID(), false);
      await schedules.reschedule(analyst, proposal.id, randomUUID(), true);
      expect(
        await db.query(
          'SELECT "scheduleVersion","scheduleBaselineMinor" FROM pro_credit_contracts WHERE "creditId"=$1',
          [c.id],
        ),
      ).toEqual([{ scheduleVersion: 2, scheduleBaselineMinor: '2500' }]);
      expect(
        json<Page<CollectionDebtor>>(
          await get('/zwanga-pro/admin/collections/debtors').expect(200),
        ).items,
      ).toEqual([]);
      // Fixture-only payment after approval; no external provider or worker.
      await db.transaction(async (m) => {
        await m.query(
          'INSERT INTO asset_credit_entries("creditId","driverId",kind,"amountMinor","sourceKey") VALUES($1,$2,\'wallet\',1000,$3)',
          [c.id, debtor.userId, randomUUID()],
        );
        await m.query('UPDATE asset_credits SET "paidMinor"=3500 WHERE id=$1', [
          c.id,
        ]);
      });
      const balances = await db.query<
        { lateMinor: string; remainingMinor: string }[]
      >(
        `WITH ${COLLECTION_BALANCES_CTE} SELECT "lateMinor"::text,"remainingMinor"::text FROM balances WHERE id=$3`,
        [past(-15), CREDIT_COST_VERSION, c.id],
      );
      expect(balances).toEqual([{ lateMinor: '6500', remainingMinor: '6500' }]);
      const history = json<Page<RecoveryHistoryItem>>(
        await get(`/zwanga-pro/admin/credits/${c.id}/recovery-actions`).expect(
          200,
        ),
      );
      expect(history.items.map((i) => i.action)).toEqual([
        'reschedule_approved',
        'reschedule_consented',
        'reschedule_proposed',
      ]);
    });
    it('uses a strict dueAt boundary for catalogue installments', async () => {
      const at = '2028-02-07T12:00:00.000Z';
      await credit({ catalogue: true, due: [{ amount: '10000', at }] });
      const balances = await db.query<Record<string, unknown>[]>(
        `WITH ${COLLECTION_BALANCES_CTE} SELECT * FROM balances`,
        [at, CREDIT_COST_VERSION],
      );
      expect(balances).toEqual([]);
    });
    it.each(['manager', 'accountant', 'auditor'])(
      'applies persisted %s read/write permissions',
      async (role) => {
        const actor = await user('driver', role);
        const c = await credit();
        await get('/zwanga-pro/admin/collections/debtors', actor)
          .expect(200)
          .expect('Cache-Control', 'no-store');
        await get(
          `/zwanga-pro/admin/credits/${c.id}/recovery-actions`,
          actor,
        ).expect(200);
        await post(
          c.id,
          {
            mutationId: randomUUID(),
            kind: 'call',
            outcome: 'reached',
            note: 'Contact de test',
          },
          actor,
        ).expect(role === 'manager' ? 201 : 403);
      },
    );
    it('excludes settled, paid, inactive contracts and up-to-date or undated schedules, not inactive debtors with debt', async () => {
      await credit({ status: 'settled', paid: '10000' });
      await credit({ paid: '10000' });
      await credit({ status: 'cancelled' });
      await credit({ origin: past(1) });
      await credit({ disclosed: false });
      await credit({
        catalogue: true,
        due: [{ amount: '10000', at: past(-7) }],
      });
      expect(
        json<Page<CollectionDebtor>>(
          await get('/zwanga-pro/admin/collections/debtors').expect(200),
        ).items,
      ).toEqual([]);
      await credit();
      await db.query('UPDATE users SET "isActive"=false WHERE id=$1', [
        debtor.userId,
      ]);
      expect(
        json<Page<CollectionDebtor>>(
          await get('/zwanga-pro/admin/collections/debtors').expect(200),
        ).items[0].accountStatus,
      ).toBe('inactive');
    });
    it('keeps the latest recovery action even when its contract has since been settled', async () => {
      await credit();
      const closed = await credit({ status: 'settled', paid: '10000' });
      await store.audit(
        db.manager,
        collector.userId,
        'recovery_action',
        {
          kind: 'visit',
          outcome: 'paid',
          note: 'Ancienne observation de test',
        },
        closed.id,
      );
      const page = json<Page<CollectionDebtor>>(
        await get('/zwanga-pro/admin/collections/debtors').expect(200),
      );
      expect(page.items[0].contracts).toHaveLength(1);
      expect(page.items[0].lastAction).toMatchObject({
        kind: 'visit',
        outcome: 'paid',
      });
    });
    it('returns complete JSON examples for every new or enriched HTTP response', async () => {
      await credit({ paid: '2500' });
      const c = await credit({ catalogue: true, paid: '2500' });
      const dto = action({
        kind: 'promise',
        outcome: 'promise_to_pay',
        promisedAt: past(-2),
        promisedAmountMinor: '7500',
      });
      const receipt = await post(c.id, dto).expect(201);
      const responses: Record<string, unknown> = {
        'POST request': dto,
        'POST recovery-actions': json<unknown>(receipt),
      };
      for (const path of [
        actionPath(c.id),
        '/zwanga-pro/admin/collections/debtors',
        '/zwanga-pro/admin/contracts',
        `/zwanga-pro/admin/contracts/${c.id}`,
        '/zwanga-pro/admin/overview',
      ]) {
        const response = await get(path).expect(200);
        responses[`GET ${path}`] = json<unknown>(response);
      }
      if (process.env.COLLECTIONS_PRINT_EXAMPLES === '1')
        console.info('COLLECTIONS_HTTP_EXAMPLES', JSON.stringify(responses));
    });
    it('orders and pages all three debtor keys with a frozen asOf and bound filters', async () => {
      const owners = await Promise.all([user(), user(), user(), user()]);
      const origin = past(36);
      await credit({ owner: owners[0].userId, origin, paid: '2500' });
      await credit({ owner: owners[1].userId, origin, paid: '2500' });
      await credit({ owner: owners[2].userId, origin, paid: '2600' });
      await credit({ owner: owners[3].userId, origin: past(15) });
      const expected = [owners[0].userId, owners[1].userId]
        .sort()
        .concat(owners[2].userId, owners[3].userId);
      let after: string | null = null;
      const seen: string[] = [],
        clocks: string[] = [];
      do {
        const result: Page<CollectionDebtor> = json<Page<CollectionDebtor>>(
          await get(
            `/zwanga-pro/admin/collections/debtors?limit=1${after ? `&after=${after}` : ''}`,
          ).expect(200),
        );
        seen.push(...result.items.map((r) => r.driverId));
        clocks.push(result.asOf);
        after = result.nextCursor;
        if (after)
          await get(
            `/zwanga-pro/admin/collections/debtors?minDays=1&after=${after}`,
          ).expect(400);
      } while (after);
      expect(seen).toEqual(expected);
      expect(new Set(clocks).size).toBe(1);
      expect(
        json<Page<CollectionDebtor>>(
          await get(
            '/zwanga-pro/admin/collections/debtors?minDays=20&maxDays=23',
          ).expect(200),
        ).items,
      ).toHaveLength(3);
    });
    it('admin exposes debtor in one response, mine remains unchanged and funder detail remains redacted', async () => {
      const c = await credit({ catalogue: true });
      const list = json<Page<ContractView>>(
        await get('/zwanga-pro/admin/contracts')
          .expect(200)
          .expect('Cache-Control', 'no-store'),
      );
      expect(list.items[0]).toMatchObject({
        driverId: debtor.userId,
        debtor: {
          firstName: 'Aline',
          lastName: 'Exemple',
          phone: '+243000000001',
        },
      });
      const detail = json<ContractView>(
        await get(`/zwanga-pro/admin/contracts/${c.id}`)
          .expect(200)
          .expect('Cache-Control', 'no-store'),
      );
      expect(detail.debtor).toEqual(list.items[0].debtor);
      for (const path of ['/zwanga-pro/mine', `/zwanga-pro/mine/${c.id}`]) {
        const response = await get(path, debtor).expect(200);
        expect(JSON.stringify(response.body)).not.toContain('driverId');
        expect(JSON.stringify(response.body)).not.toContain('debtor');
      }
      const limited = json<ContractView>(
        await get(`/zwanga-pro/admin/contracts/${c.id}`, funder).expect(200),
      );
      expect(limited.driverId).toBeUndefined();
      expect(limited.debtor).toBeUndefined();
      await get('/zwanga-pro/admin/contracts', funder).expect(403);
      await get('/zwanga-pro/admin/collections/debtors', analyst).expect(403);
    });
    it.each([
      'limit=101',
      'limit=0',
      'limit=abc',
      'after=garbage',
      'minDays=-1',
      'minDays=5&maxDays=2',
      'after=%27%20OR%20true--',
    ])('rejects invalid page %s', async (query) => {
      await get(`/zwanga-pro/admin/collections/debtors?${query}`).expect(400);
    });

    it.each([
      [
        '2028-01-31T12:00:00.123456Z',
        '2028-02-29T12:00:00.123Z',
        'month',
        3,
        '0',
      ],
      ['2028-01-31T12:00:00.000Z', '2028-02-29T12:00:00.000Z', 'month', 3, '0'],
      [
        '2027-01-31T12:00:00.000Z',
        '2027-03-01T12:00:00.000Z',
        'month',
        3,
        '100',
      ],
      [
        '2028-01-31T12:00:00.000Z',
        '2028-04-01T12:00:00.000Z',
        'month',
        3,
        '5000',
      ],
      ['2028-01-31T12:00:00.000Z', '2028-02-07T12:00:00.000Z', 'week', 3, '0'],
      ['2028-01-31T12:00:00.000Z', '2028-02-07T11:59:59.999Z', 'week', 3, '0'],
      [
        '2028-01-31T12:00:00.000Z',
        '2040-01-01T12:00:00.000Z',
        'month',
        120,
        '5000',
      ],
      [
        '2028-01-31T12:00:00.000Z',
        '2040-01-01T12:00:00.000Z',
        'week',
        1,
        '10000',
      ],
    ] as const)(
      'SQL is equivalent to creditSchedule: %s, %s, %s/%s paid=%s',
      async (origin, asOf, period, count, paid) => {
        const c = await credit({ origin, period, count, paid });
        const expected = creditSchedule(c, new Date(asOf));
        const rows = await db.query<{ lateMinor: string }[]>(
          `WITH ${COLLECTION_BALANCES_CTE} SELECT "lateMinor"::text FROM balances WHERE id=$3`,
          [asOf, CREDIT_COST_VERSION, c.id],
        );
        expect(rows[0]?.lateMinor ?? '0').toBe(
          String(expected.minimumDueMinor),
        );
        if (paid === '10000') return;
        const actual = await db.query<
          {
            ordinal: number;
            dueAt: Date;
            amountMinor: string;
            remainingMinor: string;
          }[]
        >(
          `WITH ${COLLECTION_BALANCES_CTE}
      SELECT ordinal,"dueAt",amount::text AS "amountMinor",remaining::text AS "remainingMinor" FROM uncovered WHERE id=$3 ORDER BY ordinal`,
          [asOf, CREDIT_COST_VERSION, c.id],
        );
        expect(
          actual.map((i) => ({ ...i, dueAt: i.dueAt.toISOString() })),
        ).toEqual(
          expected.installments.map((i) => ({
            ...i,
            amountMinor: String(i.amountMinor),
            remainingMinor: String(i.remainingMinor),
          })),
        );
      },
    );
  },
);
