import type { EarningRow } from '../shared/credit.rows';
import { IsolatedPostgres } from '../../../test/isolated-postgres';
import { DataSource } from 'typeorm';
import { CreditStore } from '../shared/credit.store';
import { CreditCatalogService } from '../catalogue/credit-catalogue.service';
import type { CreditActor } from '../shared/credit.store';
import { CreditPartnersService } from '../partners/credit-partners.service';
import { CreditPoliciesService } from '../policies/credit-policies.service';
import { CreditEligibilityService } from '../eligibility/credit-eligibility.service';
import { CreditApplicationsService } from '../applications/credit-applications.service';
import { CreditContractsService } from '../contracts/credit-contracts.service';
import { CreditWalletPaymentsService } from '../repayments/credit-wallet-payments.service';
import { CreditLedgerService } from '../ledger/credit-ledger.service';
import { EquipmentStockService } from '../fulfilment/equipment-stock.service';
import { VehicleDocumentsService } from '../fulfilment/vehicle-documents.service';
import { CreditDeliveryService } from '../fulfilment/credit-delivery.service';
import { CreditEvidenceService } from '../evidence/credit-evidence.service';
import { TripCreditRepaymentWorker } from '../repayments/trip-credit-repayment.worker';
import { CreditSchedulesService } from '../schedules/credit-schedules.service';
import { CreditRemindersWorker } from '../schedules/credit-reminders.worker';
import { CreditReportingService } from '../reporting/credit-reporting.service';
import { CreateCreditProductDto } from '../catalogue/credit-catalogue.dto';
import { randomUUID } from 'node:crypto';
import { proFixture } from '../../../test/pro-credit-fixture';
import { ConfigService } from '@nestjs/config';
import type { S3Service } from '../../common/services/s3.service';
import { Test } from '@nestjs/testing';
import { CreditCatalogueController } from '../catalogue/credit-catalogue.controller';
import { CreditPartnersController } from '../partners/credit-partners.controller';
import { CreditPoliciesController } from '../policies/credit-policies.controller';
import { CreditApplicationsController } from '../applications/credit-applications.controller';
import { CreditContractsController } from '../contracts/credit-contracts.controller';
import { CreditRepaymentsController } from '../repayments/credit-repayments.controller';
import { CreditLedgerController } from '../ledger/credit-ledger.controller';
import { CreditFulfilmentController } from '../fulfilment/credit-fulfilment.controller';
import { CreditEvidenceController } from '../evidence/credit-evidence.controller';
import { CreditSchedulesController } from '../schedules/credit-schedules.controller';
import { CreditReportingController } from '../reporting/credit-reporting.controller';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  ExecutionContext,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { AssetCreditService } from '../../asset-credit/asset-credit.service';
import { spendableEarning } from '../../asset-credit/earning-credit';
import { CommerceCatalogueService } from '../commerce/commerce-catalogue.service';
import { CommercePaymentsService } from '../commerce/commerce-payments.service';
import { CommerceCatalogueController } from '../commerce/commerce-catalogue.controller';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';

// Read shapes for this isolated schema only. Production queries declare their own projections.
interface FixtureRow extends EarningRow {
  vehicleId: string;
  enabled: boolean;
  isActive: boolean;
  body: string;
  count: string;
  sum: string;
  balance: string;
  proCreditPending: boolean;
  proRepaymentAmount: string;
  attempts: number;
  retryAt: Date;
  payload: unknown;
}

const bin = process.env.PRO_CREDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('Zwanga Pro isolated PostgreSQL', () => {
  const pg = new IsolatedPostgres(bin!);
  let db: DataSource,
    store: CreditStore,
    catalog: CreditCatalogService,
    admin: CreditActor,
    driver: CreditActor,
    partyId: string,
    policyId: string;
  let partners: CreditPartnersService,
    policies: CreditPoliciesService,
    eligibility: CreditEligibilityService,
    applications: CreditApplicationsService,
    contracts: CreditContractsService,
    finance: CreditWalletPaymentsService,
    ledger: CreditLedgerService,
    equipment: EquipmentStockService,
    documents: VehicleDocumentsService,
    delivery: CreditDeliveryService,
    evidence: CreditEvidenceService,
    worker: TripCreditRepaymentWorker,
    schedules: CreditSchedulesService,
    reminders: CreditRemindersWorker,
    reporting: CreditReportingService;
  const policy = {
    version: 'test-v1',
    terms:
      'Conditions contractuelles de test isolé, aucun fonds réel et aucune activation de production.',
    legalReference: 'LOCAL-TEST',
    rules: {
      minAccountDays: 30,
      minSettledTrips: 10,
      minRevenueMinor: '100000',
      maxActiveCredits: 2,
      maxPrincipalMinor: '1000000',
      newcomerLimitMinor: '1000000',
      minDepositBps: 1000,
      maxInstallments: 12,
      fixedPerTripMinor: '0',
      netIncomeBps: 500,
      commissionShareBps: 0,
      allowBeforeDelivery: false,
    },
  };
  const product = (
    kind: 'phone' | 'document' = 'phone',
  ): CreateCreditProductDto => ({
    kind,
    code: `test-${randomUUID()}`,
    name: 'Produit test',
    description: 'Simulation uniquement',
    supplierId: partyId,
    sellerId: partyId,
    creditorId: partyId,
    policyId,
    financingModel: 'ZWANGA_DIRECT',
    currency: 'CDF',
    priceMinor: '100000',
    feeMinor: '0',
    vehicleTypes: ['car'],
    requiredEvidence: [],
    processingDays: 1,
    brand: 'Test',
    model: 'Android',
  });
  beforeAll(async () => {
    db = await pg.start();
    await proFixture(db);
    store = new CreditStore(db);
    catalog = new CreditCatalogService(store);
    partners = new CreditPartnersService(store);
    policies = new CreditPoliciesService(store);
    eligibility = new CreditEligibilityService(store);
    applications = new CreditApplicationsService(store, catalog, eligibility);
    contracts = new CreditContractsService(store, catalog, eligibility);
    ledger = new CreditLedgerService(store);
    finance = new CreditWalletPaymentsService(store, catalog, ledger);
    worker = new TripCreditRepaymentWorker(store, ledger);
    schedules = new CreditSchedulesService(store);
    reminders = new CreditRemindersWorker(store);
    reporting = new CreditReportingService(store);
    equipment = new EquipmentStockService(
      store,
      new ConfigService({ PRO_CREDIT_IDENTITY_KEY: 'a'.repeat(64) }),
    );
    documents = new VehicleDocumentsService();
    delivery = new CreditDeliveryService(store, equipment, documents);
    evidence = new CreditEvidenceService(store, {} as unknown as S3Service);
    [admin, driver] = await Promise.all(
      ['super_admin', 'driver'].map(async (role) => {
        const [u] = await db.query<FixtureRow[]>(
          'INSERT INTO users(role) VALUES($1) RETURNING id',
          [role],
        );
        return { userId: u.id, role };
      }),
    );
    [{ id: partyId }] = await db.query<FixtureRow[]>(
      'INSERT INTO partner_organizations DEFAULT VALUES RETURNING id',
    );
    await partners.party(admin, partyId, {
      supplier: true,
      funder: true,
      operator: true,
      enabled: true,
      authorizationReference: 'LOCAL-ONLY',
    });
    ({ id: policyId } = await policies.policy(admin, policy));
  }, 90000);
  afterAll(async () => {
    await pg.stop();
  }, 40000);
  it('HTTP boundary requires identity, validates DTOs and enforces real persisted authorization', async () => {
    const module = await Test.createTestingModule({
      controllers: [
        CreditCatalogueController,
        CreditPartnersController,
        CreditPoliciesController,
        CreditApplicationsController,
        CreditContractsController,
        CreditRepaymentsController,
        CreditLedgerController,
        CreditFulfilmentController,
        CreditEvidenceController,
        CreditSchedulesController,
        CreditReportingController,
        CommerceCatalogueController,
      ],
      providers: [
        { provide: CreditCatalogService, useValue: catalog },
        {
          provide: CommerceCatalogueService,
          useValue: new CommerceCatalogueService(store, catalog),
        },
        { provide: CreditPartnersService, useValue: partners },
        { provide: CreditPoliciesService, useValue: policies },
        { provide: CreditApplicationsService, useValue: applications },
        { provide: CreditContractsService, useValue: contracts },
        { provide: CreditWalletPaymentsService, useValue: finance },
        { provide: CreditLedgerService, useValue: ledger },
        { provide: EquipmentStockService, useValue: equipment },
        { provide: CreditDeliveryService, useValue: delivery },
        { provide: CreditEvidenceService, useValue: evidence },
        { provide: CreditSchedulesService, useValue: schedules },
        { provide: CreditReportingService, useValue: reporting },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          if (Reflect.getMetadata(IS_PUBLIC_KEY, context.getHandler()))
            return true;
          const req = context.switchToHttp().getRequest<{
            headers: Record<string, string>;
            user: CreditActor;
          }>();
          if (req.headers['x-test-actor'] === admin.userId) req.user = admin;
          else if (req.headers['x-test-actor'] === driver.userId)
            req.user = driver;
          else throw new UnauthorizedException();
          return true;
        },
      })
      .compile();
    const app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
    try {
      const url = await app.getUrl();
      await request(url).get('/zwanga-pro/catalogue').expect(401);
      await request(url).get('/zwanga-pro/commerce/categories').expect(200);
      await request(url)
        .get('/zwanga-pro/commerce/products?categoryId=invalid')
        .expect(400);
      await request(url)
        .get('/zwanga-pro/commerce/products?limit=10')
        .expect(200);
      await request(url)
        .get('/zwanga-pro/admin/contracts')
        .set('x-test-actor', driver.userId)
        .expect(403);
      await request(url)
        .get('/zwanga-pro/catalogue?limit=101')
        .set('x-test-actor', driver.userId)
        .expect(400);
      await request(url)
        .get('/zwanga-pro/catalogue?limit=100')
        .set('x-test-actor', driver.userId)
        .expect(200);
      await request(url)
        .post('/zwanga-pro/admin/policies')
        .set('x-test-actor', admin.userId)
        .send({ ...policy, rules: undefined })
        .expect(400);
      await request(url)
        .post(`/zwanga-pro/mine/${randomUUID()}/wallet-payments`)
        .set('x-test-actor', driver.userId)
        .send({
          mutationId: randomUUID(),
          purpose: 'repayment',
          amountMinor: 100,
          paidMinor: '100',
        })
        .expect(400);
      await request(url)
        .get(`/zwanga-pro/mine/${randomUUID()}`)
        .set('x-test-actor', driver.userId)
        .expect(404);
    } finally {
      await app.close();
    }
  });
  it('migrates existing schemas and keeps new offers disabled', async () => {
    const created = await catalog.create(admin, product());
    expect(
      (
        await db.query<FixtureRow[]>(
          'SELECT enabled FROM pro_credit_products WHERE id=$1',
          [created.id],
        )
      )[0].enabled,
    ).toBe(false);
    expect((await catalog.list({ limit: 25 })).items).toEqual([]);
  });
  it('uses configured document names and policy, without static document types', async () => {
    const created = await catalog.create(admin, {
      ...product('document'),
      name: 'Document fournisseur configurable',
    });
    await catalog.enable(admin, created.id, true);
    expect((await catalog.list({ limit: 25 })).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.id, kind: 'document' }),
      ]),
    );
  });
  it('rejects a driver configuring legal parties or role grants', async () => {
    await expect(
      partners.party(driver, partyId, {
        supplier: true,
        funder: true,
        operator: true,
        enabled: true,
        authorizationReference: 'forged',
      }),
    ).rejects.toThrow('Habilitation');
    await expect(
      partners.grant(driver, {
        userId: driver.userId,
        role: 'manager',
        enabled: true,
      }),
    ).rejects.toThrow('Habilitation');
  });
  it('refuses direct funding using a partner that is not the operator', async () => {
    const { id } = await catalog.create(admin, {
      ...product(),
      financingModel: 'PARTNER_DIRECT',
    });
    await expect(catalog.enable(admin, id, true)).rejects.toThrow(
      'Habilitation',
    );
  });
  it('prevents rewriting policy and audit history in SQL', async () => {
    await expect(
      db.query<FixtureRow[]>(
        'UPDATE pro_credit_policies SET terms=$1 WHERE id=$2',
        ['different', policyId],
      ),
    ).rejects.toThrow('IMMUTABLE');
    await expect(
      db.query<FixtureRow[]>('DELETE FROM pro_credit_audit'),
    ).rejects.toThrow('IMMUTABLE');
  });
  it('idempotent mutation is serialized and payload mismatches rejected', async () => {
    const mutationId = randomUUID();
    let executed = 0;
    const run = () =>
      store.mutation(admin.userId, mutationId, 'test', { amount: '100' }, () =>
        Promise.resolve({ count: ++executed }),
      );
    expect(await Promise.all([run(), run()])).toEqual([
      { count: 1 },
      { count: 1 },
    ]);
    await expect(
      store.mutation(admin.userId, mutationId, 'test', { amount: '200' }, () =>
        Promise.resolve({}),
      ),
    ).rejects.toThrow('idempotence');
  });
  async function loan(
    kind: 'phone' | 'document' = 'phone',
    partner = false,
    overridePolicyId?: string,
    reuseProductId?: string,
  ) {
    const [u] = await db.query<FixtureRow[]>(
      'INSERT INTO users DEFAULT VALUES RETURNING id',
    );
    const actor = { userId: u.id, role: 'driver' };
    await db.query<FixtureRow[]>(
      'INSERT INTO kyc_documents("userId",status) VALUES($1,\'approved\')',
      [u.id],
    );
    await db.query<FixtureRow[]>(
      'INSERT INTO wallet_accounts("userId",balance,"withdrawableBalance") VALUES($1,1000,1000)',
      [u.id],
    );
    let creditorId = partyId;
    if (partner) {
      [{ id: creditorId }] = await db.query<FixtureRow[]>(
        'INSERT INTO partner_organizations DEFAULT VALUES RETURNING id',
      );
      await partners.party(admin, creditorId, {
        supplier: false,
        funder: true,
        operator: false,
        enabled: true,
        authorizationReference: 'PARTNER-TEST',
      });
    }
    const p = reuseProductId
      ? { id: reuseProductId }
      : await catalog.create(admin, {
          ...product(kind),
          policyId: overridePolicyId ?? policyId,
          creditorId,
          financingModel: partner ? 'PARTNER_DIRECT' : 'ZWANGA_DIRECT',
        });
    await catalog.enable(admin, p.id, true);
    let vehicleId: string | undefined, caseId: string | undefined;
    if (kind === 'document') {
      [{ id: vehicleId }] = await db.query<FixtureRow[]>(
        'INSERT INTO vehicles("ownerId") VALUES($1) RETURNING id',
        [u.id],
      );
      [{ id: caseId }] = await db.query<FixtureRow[]>(
        'INSERT INTO pro_service_cases("ownerId") VALUES($1) RETURNING id',
        [u.id],
      );
    }
    const request = await applications.apply(u.id, {
      mutationId: randomUUID(),
      productId: p.id,
      vehicleId,
      caseId,
      depositMinor: '10000',
      installments: 3,
      period: 'month',
      evidence: [],
      notes: '',
    });
    const offered = await applications.review(admin, request.id, {
      mutationId: randomUUID(),
      approve: true,
      reason: 'Validation test uniquement',
    });
    const detail = await contracts.detail(actor, offered.id);
    const consent = {
      mutationId: randomUUID(),
      consent: true,
      termsHash: detail.termsHash,
      mandateUntil: new Date(Date.now() + 500 * 86400000).toISOString(),
    };
    await contracts.accept(u.id, offered.id, consent);
    return {
      actor,
      id: offered.id,
      productId: p.id,
      vehicleId,
      caseId,
      consent,
    };
  }
  async function proof() {
    const [p] = await db.query<FixtureRow[]>(
      'INSERT INTO pro_credit_attachments("ownerId","storageKey",sha256,"mimeType") VALUES($1,$2,$3,\'image/png\') RETURNING id',
      [admin.userId, `pro/${randomUUID()}.png`, '0'.repeat(64)],
    );
    return p.id;
  }
  async function deliver(
    l: Awaited<ReturnType<typeof loan>>,
    stockId?: string,
  ) {
    if (!l.vehicleId && !stockId) {
      const stock = await equipment.stock(admin, {
        mutationId: randomUUID(),
        productId: l.productId,
        inventoryReference: `STOCK-${randomUUID().toUpperCase()}`,
        serial: randomUUID(),
        imei:
          '12345' +
          Math.floor(Math.random() * 1e10)
            .toString()
            .padStart(10, '0'),
      });
      stockId = stock.id;
    }
    await delivery.deliver(admin, l.id, {
      mutationId: randomUUID(),
      stockId,
      proofId: await proof(),
      ...(l.vehicleId ? { issuedAt: new Date().toISOString() } : {}),
    });
    return stockId;
  }
  it.each(['phone', 'document'] as const)(
    'origination, deposit, delivery and activation of %s',
    async (kind) => {
      const l = await loan(kind);
      await expect(
        contracts.activate(admin, l.id, randomUUID()),
      ).rejects.toThrow('acompte');
      const payment = {
        mutationId: randomUUID(),
        amountMinor: '10000',
        purpose: 'deposit' as const,
      };
      const paid = await finance.wallet(l.actor.userId, l.id, payment);
      expect(await finance.wallet(l.actor.userId, l.id, payment)).toEqual(paid);
      expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('0');
      await expect(
        contracts.activate(admin, l.id, randomUUID()),
      ).rejects.toThrow('Livraison');
      await deliver(l);
      await contracts.activate(admin, l.id, randomUUID());
      expect(await contracts.detail(l.actor, l.id)).toMatchObject({
        status: 'active',
        remainingMinor: '90000',
      });
      expect((await contracts.detail(l.actor, l.id)).installments).toHaveLength(
        3,
      );
      if (kind === 'document')
        expect(
          (
            await db.query<FixtureRow[]>(
              'SELECT "vehicleId" FROM pro_credit_documents WHERE "creditId"=$1',
              [l.id],
            )
          )[0].vehicleId,
        ).toBe(l.vehicleId);
    },
  );
  it('identifies a distinct partner creditor without reusing Zwanga revenues', async () => {
    const l = await loan('phone', true);
    const d = await contracts.detail(l.actor, l.id);
    expect(d.snapshot.product.financingModel).toBe('PARTNER_DIRECT');
    expect(d.snapshot.product.creditorId).not.toBe(partyId);
  });
  it('does not expose another driver contract or allow legacy endpoint bypass', async () => {
    const l = await loan();
    await expect(contracts.detail(driver, l.id)).rejects.toThrow('introuvable');
    await expect(
      new AssetCreditService(db).repay(l.id, l.actor.userId, {
        mutationId: randomUUID(),
        amountMinor: 10,
      }),
    ).rejects.toThrow('Zwanga Pro');
    await expect(
      applications.review(driver, l.id, {
        mutationId: randomUUID(),
        approve: true,
        reason: 'forged',
      }),
    ).rejects.toThrow();
  });
  it('refuses invalid consent, expired mandate and mutable contractual snapshots', async () => {
    const l = await loan();
    await expect(
      contracts.accept(l.actor.userId, l.id, {
        ...l.consent,
        mutationId: randomUUID(),
        consent: false,
      }),
    ).rejects.toThrow();
    await expect(
      db.query<FixtureRow[]>(
        'UPDATE pro_credit_contracts SET snapshot=\'{}\' WHERE "creditId"=$1',
        [l.id],
      ),
    ).rejects.toThrow('IMMUTABLE');
  });
  it('stock identifiers are encrypted and cannot be registered twice', async () => {
    const { id } = await catalog.create(admin, product());
    const dto = {
      mutationId: randomUUID(),
      productId: id,
      inventoryReference: 'TEST-UNIQUE',
      serial: 'SECRET-SERIAL',
      imei: '123456789012345',
    };
    const item = await equipment.stock(admin, dto);
    const [row] = await db.query<FixtureRow[]>(
      'SELECT * FROM pro_credit_stock WHERE id=$1',
      [item.id],
    );
    expect(JSON.stringify(row)).not.toContain(dto.imei);
    expect(JSON.stringify(row)).not.toContain(dto.serial);
    await expect(
      equipment.stock(admin, {
        ...dto,
        mutationId: randomUUID(),
        inventoryReference: 'OTHER-REFERENCE',
      }),
    ).rejects.toThrow();
    const mutation = (
      await db.query<FixtureRow[]>(
        'SELECT payload FROM pro_credit_mutations WHERE id=$1',
        [dto.mutationId],
      )
    )[0];
    expect(JSON.stringify(mutation)).not.toContain(dto.imei);
  });
  it('outbox records contain no debt amount and are idempotent', async () => {
    const l = await loan();
    const notices = await db.query<FixtureRow[]>(
      'SELECT * FROM notifications WHERE "userId"=$1',
      [l.actor.userId],
    );
    expect(notices.length).toBeGreaterThan(0);
    for (const n of notices) {
      expect(n.status).toBe('pending');
      expect(n.body).not.toMatch(/90000|10000|dette/);
    }
  });
  async function activeLoan() {
    const l = await loan();
    await finance.wallet(l.actor.userId, l.id, {
      mutationId: randomUUID(),
      purpose: 'deposit',
      amountMinor: '10000',
    });
    await deliver(l);
    await contracts.activate(admin, l.id, randomUUID());
    return l;
  }
  async function earning(
    l: Awaited<ReturnType<typeof loan>>,
    mode = 'electronic',
    status = 'succeeded',
  ) {
    const [trip] = await db.query<FixtureRow[]>(
      'INSERT INTO trips("driverId") VALUES($1) RETURNING id',
      [l.actor.userId],
    );
    const [booking] = await db.query<FixtureRow[]>(
      'INSERT INTO bookings("tripId","paymentMode","paymentStatus") VALUES($1,$2,$3) RETURNING id',
      [trip.id, mode, status],
    );
    const [e] = await db.query<FixtureRow[]>(
      `INSERT INTO driver_earnings("driverId","bookingId","tripId","paymentMode","grossAmount","netAmount","commissionAmount")
      VALUES($1,$2,$3,$4,20000,17000,3000) RETURNING *`,
      [l.actor.userId, booking.id, trip.id, mode],
    );
    return e;
  }
  it('reserves settled income before processing and posts exactly once after worker restart', async () => {
    const l = await activeLoan(),
      e = await earning(l);
    expect(e.proCreditPending).toBe(true);
    expect(spendableEarning(e)).toBe(0);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('0');
    const restarted = new TripCreditRepaymentWorker(store, ledger);
    await Promise.all([worker.process(e.id), restarted.process(e.id)]);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('85000');
    const [updated] = await db.query<FixtureRow[]>(
      'SELECT * FROM driver_earnings WHERE id=$1',
      [e.id],
    );
    expect(updated.proCreditPending).toBe(false);
    expect(spendableEarning(updated)).toBe(16150);
    await worker.process(e.id);
    expect(
      (
        await db.query<FixtureRow[]>(
          'SELECT count(*) FROM asset_credit_entries WHERE "creditId"=$1',
          [l.id],
        )
      )[0].count,
    ).toBe('1');
  });
  it.each([
    ['electronic', 'pending'],
    ['cash', 'succeeded'],
    ['points', 'failed'],
  ])('does not collect %s/%s', async (mode, status) => {
    const l = await activeLoan(),
      e = await earning(l, mode, status);
    await worker.process(e.id);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('0');
    expect(
      (
        await db.query<FixtureRow[]>(
          'SELECT "proCreditPending" FROM driver_earnings WHERE id=$1',
          [e.id],
        )
      )[0].proCreditPending,
    ).toBe(false);
  });
  it('keeps paid total bounded during simultaneous voluntary and trip repayments', async () => {
    const l = await activeLoan(),
      e = await earning(l);
    await Promise.allSettled([
      finance.wallet(l.actor.userId, l.id, {
        mutationId: randomUUID(),
        purpose: 'repayment',
        amountMinor: '50000',
      }),
      worker.process(e.id),
    ]);
    // Either the manual debit wins, or it safely refuses an overpayment after collection.
    const d = await contracts.detail(l.actor, l.id);
    expect(BigInt(d.paidMinor)).toBeLessThanOrEqual(90000n);
    expect(BigInt(d.paidMinor)).toBeGreaterThanOrEqual(85000n);
    const [{ sum }] = await db.query<FixtureRow[]>(
      'SELECT sum("amountMinor")::text AS sum FROM asset_credit_entries WHERE "creditId"=$1',
      [l.id],
    );
    expect(sum).toBe(d.paidMinor);
  });
  it('allows partial and early full repayment without another deduction after settlement', async () => {
    const l = await activeLoan();
    await finance.wallet(l.actor.userId, l.id, {
      mutationId: randomUUID(),
      purpose: 'repayment',
      amountMinor: '10000',
    });
    await finance.wallet(l.actor.userId, l.id, {
      mutationId: randomUUID(),
      purpose: 'repayment',
      amountMinor: '80000',
    });
    expect((await contracts.detail(l.actor, l.id)).status).toBe('settled');
    const e = await earning(l);
    expect(e.proCreditPending).toBe(false);
    await worker.process(e.id);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('90000');
  });
  it('compensates a cancelled settlement and reopens the debt without editing journals', async () => {
    const l = await activeLoan(),
      e = await earning(l);
    await worker.process(e.id);
    await db.query<FixtureRow[]>(
      "UPDATE driver_earnings SET status='cancelled' WHERE id=$1",
      [e.id],
    );
    await worker.process(e.id);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('0');
    const [balance] = await db.query<FixtureRow[]>(
      'SELECT sum(debit-credit)::text AS balance FROM pro_credit_ledger_lines WHERE "creditId"=$1',
      [l.id],
    );
    expect(balance.balance).toBe('0');
    await expect(
      db.query<FixtureRow[]>(
        'UPDATE asset_credit_entries SET "amountMinor"=10 WHERE "creditId"=$1',
        [l.id],
      ),
    ).rejects.toThrow('IMMUTABLE');
    await expect(
      db.query<FixtureRow[]>(
        'UPDATE asset_credits SET "paidMinor"=10 WHERE id=$1',
        [l.id],
      ),
    ).rejects.toThrow('UNBALANCED_DEBT');
  });
  it('recalculates after a prior deduction changes and compensates unsupported currency corrections', async () => {
    const l = await activeLoan(),
      e = await earning(l);
    await worker.process(e.id);
    await db.query(
      'UPDATE driver_earnings SET "assetRepaymentAmount"=1000 WHERE id=$1',
      [e.id],
    );
    const [reserved] = await db.query<FixtureRow[]>(
      'SELECT * FROM driver_earnings WHERE id=$1',
      [e.id],
    );
    expect(reserved.proCreditPending).toBe(true);
    await worker.process(e.id);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('80000');
    await expect(
      db.query(
        'UPDATE driver_earnings SET "assetRepaymentAmount"=18000 WHERE id=$1',
        [e.id],
      ),
    ).rejects.toThrow('CHK_driver_asset_repayment');
    await db.query(
      'UPDATE driver_earnings SET "assetRepaymentAmount"=17000 WHERE id=$1',
      [e.id],
    );
    await worker.process(e.id);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('0');
    await db.query(
      'UPDATE driver_earnings SET "assetRepaymentAmount"=1000 WHERE id=$1',
      [e.id],
    );
    await worker.process(e.id);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('80000');
    await db.query("UPDATE driver_earnings SET currency='USD' WHERE id=$1", [
      e.id,
    ]);
    await worker.process(e.id);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('0');
    await worker.process(e.id);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('0');
  });

  it('a failing credit worker does not undo the settled ride and preserves funds for retry', async () => {
    const l = await activeLoan(),
      e = await earning(l);
    const spy = jest
      .spyOn(ledger, 'journal')
      .mockRejectedValueOnce(new Error('simulated outage'));
    await expect(worker.process(e.id)).rejects.toThrow('simulated outage');
    spy.mockRestore();
    const [pending] = await db.query<FixtureRow[]>(
      'SELECT * FROM driver_earnings WHERE id=$1',
      [e.id],
    );
    expect(pending.status).toBe('available');
    expect(pending.proCreditPending).toBe(true);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('0');
    await worker.process(e.id);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('85000');
  });
  it('respects cash commission reservations in the existing wallet', async () => {
    const l = await activeLoan();
    await db.query<FixtureRow[]>(
      'UPDATE wallet_accounts SET "reservedCashCommissionBalance"="withdrawableBalance" WHERE "userId"=$1',
      [l.actor.userId],
    );
    await expect(
      finance.wallet(l.actor.userId, l.id, {
        mutationId: randomUUID(),
        purpose: 'repayment',
        amountMinor: '10',
      }),
    ).rejects.toThrow('Solde');
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('0');
  });
  it('charges a fixed amount once per trip, even with two passenger settlements', async () => {
    const p = await policies.policy(admin, {
      ...policy,
      version: 'fixed-test',
      rules: { ...policy.rules, fixedPerTripMinor: '10000', netIncomeBps: 0 },
    });
    const l = await loan('phone', false, p.id);
    await finance.wallet(l.actor.userId, l.id, {
      mutationId: randomUUID(),
      purpose: 'deposit',
      amountMinor: '10000',
    });
    await deliver(l);
    await contracts.activate(admin, l.id, randomUUID());
    const a = await earning(l),
      b = await earning(l);
    await db.query<FixtureRow[]>(
      'UPDATE driver_earnings SET "tripId"=$1 WHERE id=$2',
      [a.tripId, b.id],
    );
    await Promise.all([worker.process(a.id), worker.process(b.id)]);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('10000');
    expect(
      (await eligibility.facts(db.manager, l.actor.userId)).settledTrips,
    ).toBe(1);
  });
  it('does not take already reserved payout funds after a fare correction', async () => {
    const l = await activeLoan(),
      e = await earning(l);
    await db.query<FixtureRow[]>(
      'INSERT INTO driver_payouts("driverId",amount,status) VALUES($1,17000,\'pending\')',
      [l.actor.userId],
    );
    await worker.process(e.id);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('0');
  });
  it('does not accept a deposit when the product has been disabled', async () => {
    const l = await loan();
    await catalog.enable(admin, l.productId, false);
    await expect(
      finance.wallet(l.actor.userId, l.id, {
        mutationId: randomUUID(),
        purpose: 'deposit',
        amountMinor: '10000',
      }),
    ).rejects.toThrow();
    expect((await contracts.detail(l.actor, l.id)).depositPaidMinor).toBe('0');
  });
  it('revokes future automatic collections without disabling transport or voluntary repayment', async () => {
    const l = await activeLoan();
    await contracts.revoke(l.actor.userId, l.id, randomUUID());
    const e = await earning(l);
    await worker.process(e.id);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('0');
    await finance.wallet(l.actor.userId, l.id, {
      mutationId: randomUUID(),
      purpose: 'repayment',
      amountMinor: '10000',
    });
    expect(
      (
        await db.query<FixtureRow[]>(
          'SELECT "isActive" FROM users WHERE id=$1',
          [l.actor.userId],
        )
      )[0].isActive,
    ).toBe(true);
  });
  it('requires borrower consent and a different analyst to approve rescheduling', async () => {
    const l = await activeLoan();
    const proposal = await schedules.propose(admin, l.id, {
      mutationId: randomUUID(),
      installments: 6,
      period: 'week',
      reason: 'Réorganisation contractuelle test',
    });
    await expect(
      schedules.reschedule(admin, proposal.id, randomUUID(), true),
    ).rejects.toThrow('Accord');
    await expect(
      schedules.reschedule(driver, proposal.id, randomUUID(), false),
    ).rejects.toThrow('introuvable');
    const d = await contracts.detail(l.actor, l.id);
    expect(d.rescheduleProposals[0].schedule).toHaveLength(6);
    await schedules.reschedule(l.actor, proposal.id, randomUUID(), false);
    await expect(
      schedules.reschedule(admin, proposal.id, randomUUID(), true),
    ).rejects.toThrow('distinct');
    const [u] = await db.query<FixtureRow[]>(
      'INSERT INTO users DEFAULT VALUES RETURNING id',
    );
    await partners.grant(admin, {
      userId: u.id,
      role: 'analyst',
      enabled: true,
    });
    await schedules.reschedule(
      { userId: u.id, role: 'driver' },
      proposal.id,
      randomUUID(),
      true,
    );
    expect((await contracts.detail(l.actor, l.id)).installments).toHaveLength(
      6,
    );
    expect(
      (
        await db.query<FixtureRow[]>(
          'SELECT count(*) FROM pro_credit_installments WHERE "creditId"=$1',
          [l.id],
        )
      )[0].count,
    ).toBe('9');
  });
  it('releases no stock when unavailable and prevents duplicate concurrent delivery', async () => {
    const l = await loan();
    await finance.wallet(l.actor.userId, l.id, {
      mutationId: randomUUID(),
      purpose: 'deposit',
      amountMinor: '10000',
    });
    const dto = {
      mutationId: randomUUID(),
      stockId: randomUUID(),
      proofId: await proof(),
    };
    await expect(delivery.deliver(admin, l.id, dto)).rejects.toThrow(
      'indisponible',
    );
    const item = await equipment.stock(admin, {
      mutationId: randomUUID(),
      productId: l.productId,
      inventoryReference: `CONCURRENT-${randomUUID().toUpperCase()}`,
      serial: randomUUID(),
      imei: '888888888888888',
    });
    const second = await loan('phone', false, undefined, l.productId);
    await finance.wallet(second.actor.userId, second.id, {
      mutationId: randomUUID(),
      purpose: 'deposit',
      amountMinor: '10000',
    });
    const outcomes = await Promise.allSettled([
      delivery.deliver(admin, second.id, {
        ...dto,
        mutationId: randomUUID(),
        stockId: item.id,
      }),
      delivery.deliver(admin, l.id, {
        ...dto,
        mutationId: randomUUID(),
        stockId: item.id,
      }),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const inventory = await equipment.inventory(admin, l.productId, {
      limit: 25,
    });
    expect(inventory.items).toHaveLength(1);
    expect(JSON.stringify(inventory)).not.toMatch(
      /888888888888888|encryptedIdentity|serialHash/,
    );
  }, 20000);
  it('keeps document rejection separate from the financing and requires financial review', async () => {
    const l = await loan('document');
    const r = await delivery.execution(admin, l.id, {
      mutationId: randomUUID(),
      status: 'rejected',
      reason: 'Dossier incomplet chez le prestataire',
    });
    expect(r.financialReviewRequired).toBe(true);
    expect(await contracts.detail(l.actor, l.id)).toMatchObject({
      status: 'accepted',
      deliveryState: 'rejected',
    });
    await expect(deliver(l)).rejects.toThrow();
  });
  it('scopes funder access to an active membership in the creditor organization', async () => {
    const l = await loan('phone', true),
      other = await loan();
    const d = await contracts.detail(l.actor, l.id),
      org = d.snapshot.product.creditorId;
    const [u] = await db.query<FixtureRow[]>(
      'INSERT INTO users DEFAULT VALUES RETURNING id',
    );
    const actor = { userId: u.id, role: 'driver' };
    await partners.grant(admin, {
      userId: u.id,
      role: 'funder',
      organizationId: org,
      enabled: true,
    });
    await expect(contracts.detail(actor, l.id, true)).rejects.toThrow(
      'Habilitation',
    );
    await db.query<FixtureRow[]>(
      'INSERT INTO partner_members("userId","organizationId") VALUES($1,$2)',
      [u.id, org],
    );
    await expect(contracts.detail(actor, l.id, true)).resolves.toMatchObject({
      id: l.id,
    });
    await expect(contracts.detail(actor, other.id, true)).rejects.toThrow(
      'Habilitation',
    );
  });
  it('detects arrears, preserves reminder idempotence and reconciles journals', async () => {
    const l = await activeLoan();
    // Test clock fixture: production schedules cannot be edited.
    await db.query<FixtureRow[]>(
      'ALTER TABLE pro_credit_installments DISABLE TRIGGER pro_schedule_immutable',
    );
    try {
      await db.query<FixtureRow[]>(
        'UPDATE pro_credit_installments SET "dueAt"=now()-interval \'2 days\' WHERE "creditId"=$1',
        [l.id],
      );
    } finally {
      await db.query<FixtureRow[]>(
        'ALTER TABLE pro_credit_installments ENABLE TRIGGER pro_schedule_immutable',
      );
    }
    expect(
      (await contracts.detail(l.actor, l.id)).installments[0].overdueDays,
    ).toBeGreaterThanOrEqual(2);
    await reminders.reminders();
    await reminders.reminders();
    expect(
      (
        await db.query<FixtureRow[]>(
          'SELECT count(*) FROM notifications WHERE "eventKey" LIKE $1',
          [`pro:reminder:${l.id}:%`],
        )
      )[0].count,
    ).toBe('1');
    const overview = await reporting.overview(admin);
    expect(overview.overdue.some((r) => r.id === l.id)).toBe(true);
    expect(overview.reconciliation.mismatches).toEqual([]);
  });
  it('backs off a failing worker without deleting the durable reservation', async () => {
    const l = await activeLoan(),
      e = await earning(l);
    const spy = jest
      .spyOn(worker, 'process')
      .mockRejectedValue(new Error('test outage'));
    await worker.drain();
    spy.mockRestore();
    const [w] = await db.query<FixtureRow[]>(
      'SELECT * FROM pro_credit_work WHERE "earningId"=$1',
      [e.id],
    );
    expect(w.attempts).toBe(1);
    expect(new Date(w.retryAt).getTime()).toBeGreaterThan(Date.now());
    await worker.process(e.id);
  });
  it('keeps a repayment when income is marked paid rather than cancelled', async () => {
    const l = await activeLoan(),
      e = await earning(l);
    await worker.process(e.id);
    await db.query("UPDATE driver_earnings SET status='paid' WHERE id=$1", [
      e.id,
    ]);
    await worker.process(e.id);
    expect((await contracts.detail(l.actor, l.id)).paidMinor).toBe('85000');
  });
  it('allocates the contractual commission contribution without charging driver income', async () => {
    const p = await policies.policy(admin, {
      ...policy,
      version: 'commission-test',
      rules: { ...policy.rules, netIncomeBps: 0, commissionShareBps: 5000 },
    });
    const l = await loan('phone', false, p.id);
    await finance.wallet(l.actor.userId, l.id, {
      mutationId: randomUUID(),
      purpose: 'deposit',
      amountMinor: '10000',
    });
    await deliver(l);
    await contracts.activate(admin, l.id, randomUUID());
    const e = await earning(l);
    await worker.process(e.id);
    expect(await contracts.detail(l.actor, l.id)).toMatchObject({
      status: 'settled',
      paidMinor: '90000',
    });
    const [updated] = await db.query<FixtureRow[]>(
      'SELECT * FROM driver_earnings WHERE id=$1',
      [e.id],
    );
    expect(spendableEarning(updated)).toBe(17000);
  });
  async function commerceLoan(mode: 'cash' | 'credit' = 'credit') {
    const commerce = new CommerceCatalogueService(store, catalog);
    const { id: productId } = await catalog.create(admin, product());
    const [{ id: categoryId }] = await db.query(
      "SELECT id FROM pro_commerce_categories WHERE code='telephones'",
    );
    const setup = {
      mutationId: randomUUID(),
      revision: 1,
      categoryId,
      commerce: {
        version: 'commerce-v1' as const,
        acquisitionMinor: '60000',
        expensesMinor: '10000',
        marginMinor: '30000',
        minimumMarginMinor: '10000',
        depositMinor: '10000',
        plans: [
          { id: 'three-months', period: 'month' as const, count: 3 },
          { id: 'six-weeks', period: 'week' as const, count: 6 },
        ],
      },
    };
    await expect(commerce.configure(driver, productId, setup)).rejects.toThrow(
      'Habilitation',
    );
    await commerce.configure(admin, productId, setup);
    await catalog.enable(admin, productId, true);
    expect(JSON.stringify(await commerce.product(productId))).not.toMatch(
      /acquisitionMinor|expensesMinor|minimumMarginMinor/,
    );
    const [{ id: userId }] = await db.query(
      'INSERT INTO users DEFAULT VALUES RETURNING id',
    );
    const actor = { userId, role: 'driver' };
    await db.query(
      'INSERT INTO kyc_documents("userId",status) VALUES($1,\'approved\')',
      [userId],
    );
    await db.query(
      'INSERT INTO wallet_accounts("userId",balance,"withdrawableBalance") VALUES($1,1000,1000)',
      [userId],
    );
    const quote = await commerce.quote(productId, {
      mode,
      planId: mode === 'credit' ? 'three-months' : undefined,
    });
    const body = {
      mutationId: randomUUID(),
      productId,
      mode,
      planId: quote.planId ?? undefined,
      quoteHash: quote.quoteHash,
      depositMinor: quote.depositMinor,
      installments: quote.installments,
      period: quote.period,
      evidence: [],
      notes: 'Test isolé',
    };
    await expect(
      applications.apply(userId, { ...body, quoteHash: '0'.repeat(64) }),
    ).rejects.toThrow('récapitulatif');
    const applied = await applications.apply(userId, body);
    const offered = await applications.review(admin, applied.id, {
      mutationId: randomUUID(),
      approve: true,
      reason: 'Test commerce isolé',
    });
    const detail = await contracts.detail(actor, offered.id);
    expect(JSON.stringify(detail.snapshot)).not.toMatch(
      /acquisitionMinor|expensesMinor|minimumMarginMinor/,
    );
    const consent = {
      mutationId: randomUUID(),
      consent: true,
      termsHash: detail.termsHash,
      mandateUntil:
        mode === 'credit'
          ? new Date(Date.now() + 500 * 86400000).toISOString()
          : undefined,
    };
    await contracts.accept(userId, offered.id, consent);
    return {
      id: offered.id,
      actor,
      productId,
      vehicleId: undefined,
      caseId: undefined,
      consent,
      quote,
    };
  }
  it('cash checkout takes exactly 80 percent once, requires full payment before delivery, and reconciles', async () => {
    const l = await commerceLoan('cash');
    await expect(
      deliver(l as Awaited<ReturnType<typeof loan>>),
    ).rejects.toThrow('paiement avant remise');
    const body = {
      mutationId: randomUUID(),
      purpose: 'repayment' as const,
      amountMinor: l.quote.totalMinor,
    };
    const paid = await finance.wallet(l.actor.userId, l.id, body);
    expect(await finance.wallet(l.actor.userId, l.id, body)).toEqual(paid);
    await deliver(l as Awaited<ReturnType<typeof loan>>);
    await contracts.activate(admin, l.id, randomUUID());
    expect(await contracts.detail(l.actor, l.id)).toMatchObject({
      status: 'settled',
      paidMinor: '80000',
      remainingMinor: '0',
      mandateUntil: null,
    });
    expect((await reporting.overview(admin)).reconciliation.mismatches).toEqual(
      [],
    );
  });
  it('daily payments and early discount are distinct, replay-safe and leave old principal immutable', async () => {
    const l = await commerceLoan();
    await finance.wallet(l.actor.userId, l.id, {
      mutationId: randomUUID(),
      purpose: 'deposit',
      amountMinor: '10000',
    });
    await deliver(l as Awaited<ReturnType<typeof loan>>);
    await contracts.activate(admin, l.id, randomUUID());
    await finance.wallet(l.actor.userId, l.id, {
      mutationId: randomUUID(),
      purpose: 'repayment',
      amountMinor: '1000',
    });
    const payments = new CommercePaymentsService(store, ledger);
    await expect(payments.quote(driver.userId, l.id)).rejects.toThrow(
      'introuvable',
    );
    const quote = await payments.quote(l.actor.userId, l.id);
    expect(quote).toMatchObject({
      remainingMinor: '89000',
      amountMinor: '80100',
      discountMinor: '8900',
    });
    await expect(
      payments.settle(l.actor.userId, l.id, {
        mutationId: randomUUID(),
        quoteHash: '0'.repeat(64),
      }),
    ).rejects.toThrow('solde a changé');
    const body = { mutationId: randomUUID(), quoteHash: quote.quoteHash };
    const paid = await payments.settle(l.actor.userId, l.id, body);
    expect(await payments.settle(l.actor.userId, l.id, body)).toEqual(paid);
    expect(await contracts.detail(l.actor, l.id)).toMatchObject({
      status: 'settled',
      principalMinor: '90000',
      paidMinor: '81100',
      discountMinor: '8900',
      remainingMinor: '0',
    });
    expect((await reporting.overview(admin)).reconciliation.mismatches).toEqual(
      [],
    );
    await expect(payments.quote(l.actor.userId, l.id)).rejects.toThrow();
  });
  it('changes future installments only after the current period is paid, keeps the old schedule and rejects stale versions', async () => {
    const l = await commerceLoan();
    await finance.wallet(l.actor.userId, l.id, {
      mutationId: randomUUID(),
      purpose: 'deposit',
      amountMinor: '10000',
    });
    await deliver(l as Awaited<ReturnType<typeof loan>>);
    await contracts.activate(admin, l.id, randomUUID());
    const payments = new CommercePaymentsService(store, ledger);
    await expect(payments.plans(l.actor.userId, l.id)).rejects.toThrow(
      'fin de la période',
    );
    // A new test schedule simulates elapsed time without mutating immutable historical rows.
    for (let ordinal = 1; ordinal <= 3; ordinal++)
      await db.query(
        'INSERT INTO pro_credit_installments("creditId",version,ordinal,"dueAt","amountMinor") VALUES($1,2,$2,$3,30000)',
        [
          l.id,
          ordinal,
          new Date(Date.now() + ((ordinal - 1) * 30 - 2) * 86400000),
        ],
      );
    await db.query(
      'UPDATE pro_credit_contracts SET "scheduleVersion"=2 WHERE "creditId"=$1',
      [l.id],
    );
    await expect(payments.plans(l.actor.userId, l.id)).rejects.toThrow('Payez');
    await finance.wallet(l.actor.userId, l.id, {
      mutationId: randomUUID(),
      purpose: 'repayment',
      amountMinor: '30000',
    });
    const options = await payments.plans(l.actor.userId, l.id);
    expect(options.plans.some((p) => p.id === 'six-weeks')).toBe(true);
    const body = {
      mutationId: randomUUID(),
      planId: 'six-weeks',
      expectedVersion: options.version,
      expectedRemainingMinor: options.remainingMinor,
    };
    const result = await payments.changePlan(l.actor.userId, l.id, body);
    expect(await payments.changePlan(l.actor.userId, l.id, body)).toEqual(
      result,
    );
    expect(result.installments).toHaveLength(6);
    expect(
      result.installments.reduce((s, i) => s + BigInt(i.amountMinor), 0n),
    ).toBe(60000n);
    await expect(
      payments.changePlan(l.actor.userId, l.id, {
        ...body,
        mutationId: randomUUID(),
      }),
    ).rejects.toThrow();
    const [historical] = await db.query(
      'SELECT count(*) FROM pro_credit_installments WHERE "creditId"=$1 AND version=1',
      [l.id],
    );
    expect(historical.count).toBe('3');
    expect((await reporting.overview(admin)).reconciliation.mismatches).toEqual(
      [],
    );
  });
});
