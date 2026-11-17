import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { FleetRegistry1780000125000 } from '../database/migrations/1780000125000-FleetRegistry';
import { FleetRegistryService } from './fleet-registry.service';
import { FleetExternalPayments1780000126000 } from '../database/migrations/1780000126000-FleetExternalPayments';
import { FleetPaymentsService } from './fleet-payments.service';
import { FleetPaymentsController } from './fleet-payments.controller';
import { FleetRegistryController } from './fleet-registry.controller';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Test } from '@nestjs/testing';
import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
const bin = process.env.ASSET_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('fleet registry: isolated PostgreSQL', () => {
  const pg = new IsolatedPostgres(bin!);
  let db: DataSource, s: FleetRegistryService;
  let payments: FleetPaymentsService, app: INestApplication;
  let org: string,
    owner: string,
    driver: string,
    outsider: string,
    vehicle: string;
  beforeAll(async () => {
    db = await pg.start();
    s = new FleetRegistryService(db);
    await db.query(`CREATE EXTENSION "uuid-ossp";
      CREATE TABLE users(id uuid PRIMARY KEY,"firstName" text DEFAULT 'Test',"lastName" text DEFAULT 'Fixture',"isDriver" boolean DEFAULT true,"isActive" boolean DEFAULT true);
      CREATE TABLE partner_organizations(id uuid PRIMARY KEY,status text DEFAULT 'ACTIVE',"displayName" text DEFAULT 'Flotte test',"partnerTypes" jsonb DEFAULT '[{"type":"FLEET_OWNER","status":"ACTIVE"}]');
      CREATE TABLE partner_members("organizationId" uuid,"userId" uuid,role text DEFAULT 'ORG_ADMIN',status text DEFAULT 'ACTIVE');
      CREATE TABLE vehicles(id uuid PRIMARY KEY,"ownerId" uuid,"isActive" boolean DEFAULT true,"licensePlate" text);
      CREATE TABLE kyc_documents(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"userId" uuid,status text DEFAULT 'approved',"createdAt" timestamptz DEFAULT now());
      CREATE TABLE trips(id uuid PRIMARY KEY,"driverId" uuid,"vehicleId" uuid,status text);`);
    await db.transaction((m) =>
      new FleetRegistry1780000125000().up(m.queryRunner!),
    );
    await db.transaction((m) =>
      new FleetExternalPayments1780000126000().up(m.queryRunner!),
    );
    payments = new FleetPaymentsService(db, s);
    const module = await Test.createTestingModule({
      controllers: [FleetPaymentsController, FleetRegistryController],
      providers: [
        { provide: FleetPaymentsService, useValue: payments },
        { provide: FleetRegistryService, useValue: s },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context) {
          const req = context.switchToHttp().getRequest();
          if (!req.headers['x-test-user']) throw new UnauthorizedException();
          req.user = { userId: req.headers['x-test-user'] };
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
    await app.init();
  }, 90000);
  afterAll(async () => {
    if (app) await app.close();
    await pg.stop();
  }, 40000);
  beforeEach(async () => {
    await db.query(
      'TRUNCATE fleet_external_payments,fleet_registry_events,fleet_registry_assignments,fleet_registry_vehicles,partner_members,partner_organizations,vehicles,kyc_documents,trips,users',
    );
    org = randomUUID();
    owner = randomUUID();
    driver = randomUUID();
    outsider = randomUUID();
    vehicle = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1),($2),($3)', [
      owner,
      driver,
      outsider,
    ]);
    await db.query('INSERT INTO partner_organizations(id) VALUES($1)', [org]);
    await db.query(
      'INSERT INTO partner_members("organizationId","userId") VALUES($1,$2)',
      [org, owner],
    );
    await db.query(
      'INSERT INTO vehicles(id,"ownerId","licensePlate") VALUES($1,$2,$3)',
      [vehicle, driver, 'TEST123'],
    );
    await db.query('INSERT INTO kyc_documents("userId") VALUES($1)', [driver]);
  });
  const dto = {
    plate: 'TEST 123',
    brand: 'Fixture',
    model: 'Test',
    color: 'Blanc',
    seats: 4,
  };
  const register = () => s.register(owner, org, dto);
  const verified = async () => {
    const r = await register();
    await s.review(owner, r.id, {
      appVehicleId: vehicle,
      verificationReference: 'preuve-test',
    });
    return r.id;
  };
  const terms =
    'Conditions de test acceptées explicitement. Aucun partage financier automatique.';
  const periodic = async () => {
    const vehicleId = await verified();
    const a = await s.assign(owner, org, vehicleId, {
      driverId: driver,
      terms,
      periodicAmountMinor: 500000,
      paymentPeriod: 'WEEKLY',
    });
    await s.decide(driver, a.id, true, true);
    return { id: a.id, vehicleId };
  };
  const declaration = () => ({
    mutationId: randomUUID(),
    amountMinor: 200000,
    paidOn: '2026-01-02',
    reference: 'reçu de test',
    periodLabel: 'Semaine de test',
  });
  it('preserves immutable periodic terms and requires explicit acknowledgment', async () => {
    const id = await verified(),
      dto = {
        driverId: driver,
        terms,
        periodicAmountMinor: 500000,
        paymentPeriod: 'WEEKLY' as const,
      };
    const a = await s.assign(owner, org, id, dto);
    await expect(
      s.assign(owner, org, id, { ...dto, periodicAmountMinor: 600000 }),
    ).rejects.toThrow('déjà affecté');
    await expect(s.decide(driver, a.id, true)).rejects.toThrow(
      'montant périodique',
    );
    expect((await s.mine(driver)).items[0]).toMatchObject({
      periodicAmountMinor: '500000',
      paymentPeriod: 'WEEKLY',
    });
    await s.decide(driver, a.id, true, true);
  });
  it('records partial external payments, counts only confirmed receipts, and supports replay', async () => {
    const a = await periodic(),
      dto = declaration();
    const [p, p2] = await Promise.all([
      payments.declare(driver, a.id, dto),
      payments.declare(driver, a.id, dto),
    ]);
    expect(p.id).toBe(p2.id);
    expect(await payments.history(driver, a.id, {})).toMatchObject({
      confirmedMinor: '0',
      declaredMinor: '200000',
    });
    await expect(
      payments.declare(driver, a.id, { ...dto, amountMinor: 100000 }),
    ).rejects.toThrow('autre versement');
    await Promise.all([
      payments.decide(owner, org, a.id, p.id, { confirm: true }),
      payments.decide(owner, org, a.id, p.id, { confirm: true }),
    ]);
    expect(await payments.history(driver, a.id, {})).toMatchObject({
      confirmedMinor: '200000',
      declaredMinor: '0',
    });
    expect((await payments.declare(driver, a.id, dto)).status).toBe(
      'CONFIRMED',
    );
    await expect(
      payments.decide(owner, org, a.id, p.id, {
        confirm: false,
        note: 'contestation',
      }),
    ).rejects.toThrow('déjà été examiné');
  });
  it('blocks outsiders, read-only members, cross-organization access and self-confirmation', async () => {
    const a = await periodic(),
      p = await payments.declare(driver, a.id, declaration());
    await expect(payments.history(outsider, a.id, {})).rejects.toThrow(
      'introuvable',
    );
    await expect(payments.declare(owner, a.id, declaration())).rejects.toThrow(
      'introuvable',
    );
    await expect(
      payments.history(owner, a.id, {}, randomUUID()),
    ).rejects.toThrow('refusé');
    await db.query("UPDATE partner_members SET role='FINANCE_VIEWER'");
    expect((await payments.history(owner, a.id, {}, org)).items).toHaveLength(
      1,
    );
    await expect(
      payments.decide(owner, org, a.id, p.id, { confirm: true }),
    ).rejects.toThrow('responsable');
    await db.query(
      'INSERT INTO partner_members("organizationId","userId") VALUES($1,$2)',
      [org, driver],
    );
    await expect(
      payments.decide(driver, org, a.id, p.id, { confirm: true }),
    ).rejects.toThrow('autre que le conducteur');
  });
  it('refusal needs a reason, preserves history, and does not count as received', async () => {
    const a = await periodic(),
      p = await payments.declare(driver, a.id, declaration());
    await expect(
      payments.decide(owner, org, a.id, p.id, { confirm: false, note: '   ' }),
    ).rejects.toThrow('pourquoi');
    await payments.decide(owner, org, a.id, p.id, {
      confirm: false,
      note: 'Référence introuvable',
    });
    const h = await payments.history(driver, a.id, {});
    expect(h).toMatchObject({ confirmedMinor: '0', declaredMinor: '0' });
    expect(h.items[0]).toMatchObject({
      status: 'REJECTED',
      decisionNote: 'Référence introuvable',
    });
  });
  it('allows settlement after closure and reconciliation during suspension without new assignment', async () => {
    const a = await periodic();
    await s.close(owner, org, a.vehicleId);
    const p = await payments.declare(driver, a.id, declaration());
    await db.query("UPDATE partner_organizations SET status='SUSPENDED'");
    await payments.decide(owner, org, a.id, p.id, { confirm: true });
    expect((await payments.assignments(owner, {}, org)).items[0].status).toBe(
      'ENDED',
    );
    await expect(
      s.assign(owner, org, a.vehicleId, { driverId: driver, terms }),
    ).rejects.toThrow('refusé');
  });
  it('does not invent payments for old nonperiodic or unaccepted contracts', async () => {
    const v = await verified(),
      a = await s.assign(owner, org, v, { driverId: driver, terms });
    await expect(payments.declare(driver, a.id, declaration())).rejects.toThrow(
      'contrat',
    );
    await s.decide(driver, a.id, true);
    await expect(payments.declare(driver, a.id, declaration())).rejects.toThrow(
      'contrat',
    );
    expect(
      (await payments.history(driver, a.id, {})).assignment.periodicAmountMinor,
    ).toBeNull();
  });
  it('paginates stable histories without hiding totals, including new concurrent declarations', async () => {
    const a = await periodic();
    for (let i = 0; i < 34; i++)
      await payments.declare(driver, a.id, {
        ...declaration(),
        reference: 'reçu ' + i,
      });
    const first = await payments.history(driver, a.id, {});
    expect(first.items).toHaveLength(30);
    await payments.declare(driver, a.id, declaration());
    const second = await payments.history(driver, a.id, {
      before: first.nextCursor,
    });
    expect(second.items).toHaveLength(4);
    expect(
      new Set([...first.items, ...second.items].map((p) => p.id)).size,
    ).toBe(34);
    expect(second).toMatchObject({
      nextCursor: null,
      declaredMinor: '7000000',
    });
  });
  it('keeps migration rollback non-destructive when contracts or payments exist', async () => {
    await periodic();
    await expect(
      db.transaction((m) =>
        new FleetExternalPayments1780000126000().down(m.queryRunner!),
      ),
    ).rejects.toThrow('Archive');
    expect((await payments.assignments(driver, {})).items).toHaveLength(1);
  });
  it('paginates past contracts by tenant and does not expose another driver history', async () => {
    const v = await verified();
    await db.query(`INSERT INTO fleet_registry_assignments("vehicleId","driverId",terms,status,"acceptedAt","endedAt")
      SELECT $1,$2,$3,'ENDED',now(),now() FROM generate_series(1,34)`,[v,driver,terms]);
    const first = await payments.assignments(owner,{},org);
    expect(first.items).toHaveLength(30);
    const second = await payments.assignments(owner,{before:first.nextCursor},org);
    expect(second.items).toHaveLength(4);
    expect(new Set([...first.items,...second.items].map(a=>a.id)).size).toBe(34);
    expect((await payments.assignments(outsider,{})).items).toHaveLength(0);
    await expect(payments.assignments(outsider,{},org)).rejects.toThrow('refusé');
  });
  it('exercises real HTTP DTOs and PostgreSQL through declaration then owner confirmation', async () => {
    const a = await periodic(),
      http = request(app.getHttpServer()),
      path = '/partners/fleet-assignments/' + a.id + '/payments';
    await http.get(path).expect(401);
    await http.get(path).set('x-test-user', outsider).expect(404);
    const dto = declaration();
    for (const invalid of [
      { ...dto, driverId: outsider },
      { ...dto, amountMinor: 0 },
      { ...dto, amountMinor: 101 },
      { ...dto, paidOn: '2026-02-30' },
      { ...dto, mutationId: 'not-uuid' },
    ])
      await http
        .post(path)
        .set('x-test-user', driver)
        .send(invalid)
        .expect(400);
    await http
      .post(path)
      .set('x-test-user', driver)
      .send({ ...dto, paidOn: '2999-01-01' })
      .expect(409);
    const { body: p } = await http
      .post(path)
      .set('x-test-user', driver)
      .send(dto)
      .expect(201);
    const decision =
      '/partners/organizations/' +
      org +
      '/fleet-assignments/' +
      a.id +
      '/payments/' +
      p.id +
      '/decide';
    await http
      .post(decision)
      .set('x-test-user', owner)
      .send({ confirm: false })
      .expect(400);
    await http
      .post(decision)
      .set('x-test-user', owner)
      .send({ confirm: true })
      .expect(201);
    const { body: h } = await http
      .get(path)
      .set('x-test-user', driver)
      .expect(200);
    expect(h).toMatchObject({ confirmedMinor: '200000', declaredMinor: '0' });
    await http
      .get(path + '?before=99999999999999999999999999')
      .set('x-test-user', driver)
      .expect(400);
    await http
      .post(
        '/partners/organizations/' +
          org +
          '/fleet-registry/' +
          a.vehicleId +
          '/assign',
      )
      .set('x-test-user', owner)
      .send({ driverId: driver, terms, paymentPeriod: 'WEEKLY' })
      .expect(400);
  });
  it('scopes every vehicle operation to active authorized members', async () => {
    const r = await register();
    await expect(s.list(outsider, org)).rejects.toThrow('refusé');
    await expect(
      s.assign(outsider, org, r.id, { driverId: driver, terms }),
    ).rejects.toThrow('refusé');
    await db.query("UPDATE partner_members SET role='VIEWER'");
    expect((await s.list(owner, org)).items).toHaveLength(1);
    await expect(register()).rejects.toThrow('refusé');
    await db.query("UPDATE partner_organizations SET status='SUSPENDED'");
    await expect(s.state(owner, org, r.id, 'PAUSED')).rejects.toThrow('refusé');
  });
  it('registration is idempotent; no assignment before verification', async () => {
    const r = await register();
    expect((await s.pendingReview()).items).toHaveLength(1);
    expect((await register()).id).toBe(r.id);
    await expect(
      s.assign(owner, org, r.id, { driverId: driver, terms }),
    ).rejects.toThrow('vérifié');
    await expect(
      s.review(owner, r.id, {
        appVehicleId: randomUUID(),
        verificationReference: 'test',
      }),
    ).rejects.toThrow('même plaque');
  });
  it('requires correct driver, KYC and explicit consent without transferring ownership', async () => {
    const id = await verified();
    expect((await s.pendingReview()).items).toHaveLength(0);
    await expect(
      s.assign(owner, org, id, { driverId: outsider, terms }),
    ).rejects.toThrow('autorisé');
    const a = await s.assign(owner, org, id, { driverId: driver, terms });
    expect((await s.mine(driver)).items[0].status).toBe('PENDING');
    await expect(s.decide(outsider, a.id, true)).rejects.toThrow('introuvable');
    await db.query("UPDATE kyc_documents SET status='pending'");
    await expect(s.decide(driver, a.id, true)).rejects.toThrow('vérifié');
    await db.query("UPDATE kyc_documents SET status='approved'");
    await s.decide(driver, a.id, true);
    await s.decide(driver, a.id, true);
    expect((await s.mine(driver)).items[0].status).toBe('ACTIVE');
    expect(
      (
        await db.query('SELECT "ownerId" FROM vehicles WHERE id=$1', [vehicle])
      )[0].ownerId,
    ).toBe(driver);
  });
  it('prevents duplicate assignments and preserves current/future trips on close', async () => {
    const id = await verified();
    const results = await Promise.all([
      s.assign(owner, org, id, { driverId: driver, terms }),
      s.assign(owner, org, id, { driverId: driver, terms }),
    ]);
    expect(results[0].id).toBe(results[1].id);
    await s.decide(driver, results[0].id, true);
    await db.query("INSERT INTO trips VALUES($1,$2,$3,'ongoing')", [
      randomUUID(),
      driver,
      vehicle,
    ]);
    await expect(s.close(owner, org, id)).rejects.toThrow('trajets');
    await db.query("UPDATE trips SET status='completed'");
    await s.close(owner, org, id);
    expect((await s.mine(driver)).items[0].status).toBe('ENDED');
    await s.state(owner, org, id, 'PAUSED');
    await expect(
      s.assign(owner, org, id, { driverId: driver, terms }),
    ).rejects.toThrow('disponible');
  });
  it('decline frees an assignment and suspension blocks acceptance', async () => {
    const id = await verified();
    const a = await s.assign(owner, org, id, { driverId: driver, terms });
    await db.query("UPDATE partner_organizations SET status='SUSPENDED'");
    await expect(s.decide(driver, a.id, true)).rejects.toThrow('indisponible');
    await s.decide(driver, a.id, false);
    expect((await s.mine(driver)).items[0].status).toBe('CANCELLED');
    expect(
      (await db.query('SELECT count(*) count FROM fleet_registry_events'))[0]
        .count,
    ).toBe('4');
  });
});
