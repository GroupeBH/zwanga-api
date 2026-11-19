import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { FleetDriverApplications1780000134000 } from '../database/migrations/1780000134000-FleetDriverApplications';
import { FleetRegistry1780000125000 } from '../database/migrations/1780000125000-FleetRegistry';
import { FleetApplicationsController } from './fleet-applications.controller';
import { FleetApplicationsService } from './fleet-applications.service';
import { FleetRegistryService } from './fleet-registry.service';
import { FleetRegistryController } from './fleet-registry.controller';

const bin = process.env.ASSET_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'fleet applications: real PostgreSQL and HTTP',
  () => {
    const pg = new IsolatedPostgres(bin!);
    let db: DataSource,
      app: INestApplication,
      service: FleetApplicationsService;
    let owner: string,
      candidate: string,
      outsider: string,
      viewer: string,
      org: string,
      otherOrg: string;
    beforeAll(async () => {
      db = await pg.start();
      await db.query(`CREATE EXTENSION "uuid-ossp";
      CREATE TABLE users(id uuid PRIMARY KEY,"firstName" text DEFAULT 'Fixture',"lastName" text DEFAULT 'Test',phone text DEFAULT '+243000000000',"isActive" boolean DEFAULT true,"isDriver" boolean DEFAULT false);
      CREATE TABLE partner_organizations(id uuid PRIMARY KEY,status text DEFAULT 'ACTIVE',"displayName" text DEFAULT 'Flotte test',"partnerTypes" jsonb DEFAULT '[{"type":"FLEET_OWNER","status":"ACTIVE"}]');
      CREATE TABLE partner_members("organizationId" uuid,"userId" uuid,role text DEFAULT 'ORG_ADMIN',status text DEFAULT 'ACTIVE');
      CREATE TABLE vehicles(id uuid PRIMARY KEY,"ownerId" uuid,"isActive" boolean DEFAULT true,"licensePlate" text);`);
      await db.transaction((m) =>
        new FleetRegistry1780000125000().up(m.queryRunner!),
      );
      await db.transaction((m) =>
        new FleetDriverApplications1780000134000().up(m.queryRunner!),
      );
      const registry = new FleetRegistryService(db);
      service = new FleetApplicationsService(db, registry);
      const mod = await Test.createTestingModule({
        controllers: [FleetApplicationsController, FleetRegistryController],
        providers: [
          { provide: FleetApplicationsService, useValue: service },
          { provide: FleetRegistryService, useValue: registry },
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue({
          canActivate(ctx) {
            const r = ctx.switchToHttp().getRequest();
            if (!r.headers['x-test-user']) throw new UnauthorizedException();
            r.user = { userId: r.headers['x-test-user'] };
            return true;
          },
        })
        .compile();
      app = mod.createNestApplication();
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
        'TRUNCATE fleet_application_events,fleet_driver_applications,fleet_registry_events,fleet_registry_assignments,fleet_registry_vehicles,partner_members,partner_organizations,vehicles,users',
      );
      [owner, candidate, outsider, viewer, org, otherOrg] = Array.from(
        { length: 6 },
        () => randomUUID(),
      );
      await db.query('INSERT INTO users(id) VALUES($1),($2),($3),($4)', [
        owner,
        candidate,
        outsider,
        viewer,
      ]);
      await db.query('INSERT INTO partner_organizations(id) VALUES($1),($2)', [
        org,
        otherOrg,
      ]);
      await db.query(
        `INSERT INTO partner_members("organizationId","userId",role) VALUES($1,$2,'FLEET_MANAGER'),($1,$3,'VIEWER'),($4,$5,'ORG_ADMIN')`,
        [org, owner, viewer, otherOrg, outsider],
      );
    });
    const apply = () =>
      service.apply(candidate, org, {
        message: 'Je souhaite rejoindre votre flotte.',
      });
    const get = (url: string, user = candidate) =>
      request(app.getHttpServer())
        .get('/partners/' + url)
        .set('x-test-user', user);
    const post = (url: string, body: object, user = candidate) =>
      request(app.getHttpServer())
        .post('/partners/' + url)
        .set('x-test-user', user)
        .send(body);

    it('registers a fleet vehicle without a driver, assignment or operational vehicle', async () => {
      const body = {
        plate: 'FLEET 123',
        brand: 'Test',
        model: 'Car',
        color: 'White',
        seats: 4,
      };
      const first = await post(
        `organizations/${org}/fleet-registry`,
        body,
        owner,
      ).expect(201);
      const repeat = await post(
        `organizations/${org}/fleet-registry`,
        body,
        owner,
      ).expect(201);
      expect(repeat.body.id).toBe(first.body.id);
      const list = await get(
        `organizations/${org}/fleet-registry`,
        owner,
      ).expect(200);
      expect(list.body.items[0]).toMatchObject({
        status: 'SUBMITTED',
        driverId: null,
        assignmentId: null,
      });
      expect(
        (await db.query('SELECT count(*) count FROM vehicles'))[0].count,
      ).toBe('0');
      await post(
        `organizations/${org}/fleet-registry`,
        { ...body, driverId: candidate },
        owner,
      ).expect(400);
      await post(`organizations/${org}/fleet-registry`, body, outsider).expect(
        403,
      );
    });
    it('lists only active fleets, paginates and treats search wildcards literally', async () => {
      await db.query(
        `UPDATE partner_organizations SET "displayName"='100% fleet' WHERE id=$1`,
        [org],
      );
      const result = await get('fleets/directory?search=%25').expect(200);
      expect(result.body.total).toBe(1);
      expect(result.body.items).toEqual([
        { id: org, displayName: '100% fleet' },
      ]);
      expect(
        (await get('fleets/directory?limit=1&page=2').expect(200)).body,
      ).toMatchObject({ total: 2, limit: 1, page: 2 });
      await db.query(
        `UPDATE partner_organizations SET status='SUSPENDED' WHERE id=$1`,
        [otherOrg],
      );
      expect((await get('fleets/directory').expect(200)).body.total).toBe(1);
      await db.query(
        `UPDATE partner_organizations SET "partnerTypes"='[{"type":"FLEET_OWNER","status":"REQUESTED"}]' WHERE id=$1`,
        [org],
      );
      expect((await get('fleets/directory').expect(200)).body.total).toBe(0);
    });
    it('accepts regular user applications, trims text and derives identity from authentication', async () => {
      const response = await post(`fleets/${org}/applications`, {
        message: '  Je recherche un véhicule de flotte.  ',
      }).expect(201);
      const mine = await get('fleet-applications/mine').expect(200);
      expect(mine.headers['cache-control']).toBe('private, no-store');
      expect(mine.body.items[0]).toMatchObject({
        id: response.body.id,
        message: 'Je recherche un véhicule de flotte.',
        status: 'PENDING',
      });
      expect(mine.body.items[0]).not.toHaveProperty('phone');
      expect((await get('fleet-applications/mine', outsider)).body.total).toBe(
        0,
      );
      await post(`fleets/${org}/applications`, {
        message: 'Texte de candidature',
        userId: outsider,
      }).expect(400);
    });
    it('deduplicates simultaneous submissions and creates one audit event', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => apply()),
      );
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(
        (
          await db.query('SELECT count(*) count FROM fleet_application_events')
        )[0].count,
      ).toBe('1');
    });
    it('restricts candidate identity and review to managers of that fleet', async () => {
      const a = await apply();
      await get(`organizations/${org}/fleet-applications`, outsider).expect(
        403,
      );
      await get(`organizations/${org}/fleet-applications`, viewer).expect(403);
      await post(
        `organizations/${org}/fleet-applications/${a.id}/review`,
        { status: 'ACCEPTED' },
        outsider,
      ).expect(403);
      await post(
        `organizations/${otherOrg}/fleet-applications/${a.id}/review`,
        { status: 'ACCEPTED' },
        outsider,
      ).expect(404);
      const managed = await get(
        `organizations/${org}/fleet-applications?status=PENDING`,
        owner,
      ).expect(200);
      expect(managed.body.items[0]).toMatchObject({
        userId: candidate,
        isDriver: false,
        applicantActive: true,
      });
      expect(managed.headers['cache-control']).toBe('private, no-store');
    });
    it('accepts without granting driver privileges, membership, assignment or financial obligations', async () => {
      const a = await apply();
      await post(
        `organizations/${org}/fleet-applications/${a.id}/review`,
        { status: 'ACCEPTED', note: 'Contactez-nous pour la suite.' },
        owner,
      ).expect(201);
      await post(
        `organizations/${org}/fleet-applications/${a.id}/review`,
        { status: 'ACCEPTED' },
        owner,
      ).expect(201);
      expect(
        (
          await db.query('SELECT "isDriver" FROM users WHERE id=$1', [
            candidate,
          ])
        )[0].isDriver,
      ).toBe(false);
      expect(
        await db.query('SELECT * FROM partner_members WHERE "userId"=$1', [
          candidate,
        ]),
      ).toEqual([]);
      expect(
        await db.query('SELECT * FROM fleet_registry_assignments'),
      ).toEqual([]);
      expect(
        (await get('fleet-applications/mine')).body.items[0].decisionNote,
      ).toBe('Contactez-nous pour la suite.');
      expect((await apply()).id).toBe(a.id);
      await post(
        `organizations/${org}/fleet-applications/${a.id}/review`,
        { status: 'REJECTED' },
        owner,
      ).expect(409);
    });
    it('withdraws only own pending applications; a new application is possible afterwards', async () => {
      const a = await apply();
      await post(`fleet-applications/${a.id}/withdraw`, {}, outsider).expect(
        404,
      );
      await post(`fleet-applications/${a.id}/withdraw`, {}).expect(201);
      await post(`fleet-applications/${a.id}/withdraw`, {}).expect(201);
      await post(
        `organizations/${org}/fleet-applications/${a.id}/review`,
        { status: 'ACCEPTED' },
        owner,
      ).expect(409);
      expect((await apply()).id).not.toBe(a.id);
    });
    it('serializes conflicting reviews and withdrawal with one final decision', async () => {
      const a = await apply();
      const result = await Promise.allSettled([
        service.review(owner, org, a.id, { status: 'ACCEPTED' }),
        service.review(owner, org, a.id, { status: 'REJECTED' }),
        service.withdraw(candidate, a.id),
      ]);
      expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        (
          await db.query(
            'SELECT count(*) count FROM fleet_application_events WHERE "applicationId"=$1',
            [a.id],
          )
        )[0].count,
      ).toBe('2');
    });
    it('blocks suspended fleets, inactive accounts and self-applications', async () => {
      await post(
        `fleets/${org}/applications`,
        { message: 'Je souhaite candidater.' },
        owner,
      ).expect(409);
      const a = await apply();
      await db.query(`UPDATE users SET "isActive"=false WHERE id=$1`, [
        candidate,
      ]);
      await post(
        `organizations/${org}/fleet-applications/${a.id}/review`,
        { status: 'ACCEPTED' },
        owner,
      ).expect(403);
      await get('fleet-applications/mine').expect(403);
      await db.query(
        `UPDATE partner_organizations SET status='SUSPENDED' WHERE id=$1`,
        [org],
      );
      await get(`organizations/${org}/fleet-applications`, owner).expect(200);
      await post(
        `organizations/${org}/fleet-applications/${a.id}/review`,
        { status: 'REJECTED' },
        owner,
      ).expect(403);
      await post(
        `fleets/${org}/applications`,
        { message: 'Je souhaite candidater.' },
        outsider,
      ).expect(404);
    });
    it('rejects invalid DTOs and unauthenticated requests', async () => {
      await request(app.getHttpServer())
        .get('/partners/fleets/directory')
        .expect(401);
      for (const query of ['limit=101', 'page=0', 'status=INVALID'])
        await get('fleet-applications/mine?' + query).expect(400);
      for (const message of ['', '         ', 'court', 'a'.repeat(2001)])
        await post(`fleets/${org}/applications`, { message }).expect(400);
      await post('fleets/not-a-uuid/applications', {
        message: 'Je souhaite candidater.',
      }).expect(400);
    });
    it('protects open uniqueness in SQL and refuses destructive rollback with data', async () => {
      await apply();
      await expect(
        db.query(
          'INSERT INTO fleet_driver_applications("organizationId","userId",message) VALUES($1,$2,$3)',
          [org, candidate, 'Une autre candidature'],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        db.transaction((m) =>
          new FleetDriverApplications1780000134000().down(m.queryRunner!),
        ),
      ).rejects.toThrow('Archive');
    });
  },
);
