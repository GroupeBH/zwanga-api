import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { AssetCredits1780000124000 } from '../database/migrations/1780000124000-AssetCredits';
import { AssetCreditService } from './asset-credit.service';
import { earningForClient } from './earning-credit';
import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import { AssetCreditController } from './asset-credit.controller';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

const bin = process.env.ASSET_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'asset credits: real isolated PostgreSQL',
  () => {
    const pg = new IsolatedPostgres(bin!);
    let db: DataSource, service: AssetCreditService;
    let app: INestApplication;
    let driver: string, admin: string, trip: string;
    beforeAll(async () => {
      db = await pg.start();
      service = new AssetCreditService(db);
      await db.query(`CREATE EXTENSION "uuid-ossp";
      CREATE TABLE users(id uuid PRIMARY KEY,"isDriver" boolean DEFAULT true,"isActive" boolean DEFAULT true);
      CREATE TABLE kyc_documents(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"userId" uuid,status text,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE trips(id uuid PRIMARY KEY,"driverId" uuid);
      CREATE TABLE bookings(id uuid PRIMARY KEY,"tripId" uuid,"paymentMode" text DEFAULT 'cash',status text DEFAULT 'completed',"paymentCurrency" text DEFAULT 'CDF',"cashReceivedAt" timestamptz,"cashReceivedAmount" numeric(12,2),"cashReceivedByDriverId" uuid);
      CREATE TABLE wallet_accounts(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"userId" uuid,type text DEFAULT 'points',balance numeric(12,2) DEFAULT 0,"withdrawableBalance" numeric(12,2) DEFAULT 0,"reservedCashCommissionBalance" numeric(12,2) DEFAULT 0,"withdrawalsBlocked" boolean DEFAULT false,currency text DEFAULT 'PTS',"updatedAt" timestamptz DEFAULT now(), UNIQUE("userId",type), CHECK(balance>=0 AND "withdrawableBalance">=0 AND "withdrawableBalance"<=balance));
      CREATE TABLE wallet_ledger_entries(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"accountId" uuid,"userId" uuid,"accountType" text,type text,amount numeric(12,2),"withdrawableAmount" numeric(12,2),"balanceAfter" numeric(12,2),currency text,"relatedEntityType" text,"relatedEntityId" uuid,description text,CONSTRAINT "CHK_wallet_ledger_type" CHECK(type IN ('top_up')));
      CREATE TABLE driver_earnings(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"driverId" uuid,"bookingId" uuid UNIQUE,"grossAmount" numeric(12,2),"netAmount" numeric(12,2),"commissionAmount" numeric(12,2),currency text DEFAULT 'CDF',status text DEFAULT 'available',"createdAt" timestamptz DEFAULT clock_timestamp(), CHECK("grossAmount"="netAmount"+"commissionAmount"));`);
      await db.transaction((m) =>
        new AssetCredits1780000124000().up(m.queryRunner!),
      );
      // Test identity injection only. Actual DTO validation, role guard, HTTP and SQL are exercised.
      const module = await Test.createTestingModule({
        controllers: [AssetCreditController],
        providers: [
          { provide: AssetCreditService, useValue: service },
          { provide: APP_GUARD, useClass: RolesGuard },
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue({
          canActivate(context) {
            const req = context.switchToHttp().getRequest();
            if (!req.headers['x-test-user']) throw new UnauthorizedException();
            req.user = {
              userId: req.headers['x-test-user'],
              role: req.headers['x-test-role'] ?? 'driver',
            };
            return true;
          },
        })
        .compile();
      app = module.createNestApplication();
      app.use((req, res, next) => {
        if (req.headers['x-test-user'])
          req.user = {
            userId: req.headers['x-test-user'],
            role: req.headers['x-test-role'] ?? 'driver',
          };
        next();
      });
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
        'TRUNCATE asset_credit_wallet_mutations,asset_credit_sources,asset_credit_entries,asset_credit_events,asset_credits,asset_credit_requests,driver_earnings,wallet_ledger_entries,wallet_accounts,bookings,trips,kyc_documents,users',
      );
      driver = randomUUID();
      admin = randomUUID();
      trip = randomUUID();
      await db.query('INSERT INTO users(id) VALUES($1),($2)', [driver, admin]);
      await db.query('INSERT INTO trips VALUES($1,$2)', [trip, driver]);
      await db.query(
        `INSERT INTO kyc_documents("userId",status) VALUES($1,'approved')`,
        [driver],
      );
      await db.query(
        'INSERT INTO wallet_accounts("userId",balance,"withdrawableBalance") VALUES($1,100,100)',
        [driver],
      );
    });
    const offer = (principalMinor = 1000000) =>
      service.offer(admin, {
        mutationId: randomUUID(),
        driverId: driver,
        assetKind: 'phone',
        label: 'Téléphone de test',
        principalMinor,
        terms:
          'Contrat de test isolé. Aucun intérêt ni frais supplémentaire. Matériel remis après accord.',
        validationReference: 'test-validation',
      });
    const active = async (amount = 1000000) => {
      const { id } = await offer(amount);
      await service.decide(id, driver, true);
      await service.activate(id, admin, {
        assetReference: `test-phone-${id}`,
        deliveryReference: 'test-delivery',
      });
      return id;
    };
    const credit = async (id: string) =>
      (await db.query('SELECT * FROM asset_credits WHERE id=$1', [id]))[0];
    const earning = async (
      amount = 10000,
      bid = randomUUID(),
      createdAt?: string,
    ) =>
      (
        await db.query(
          `INSERT INTO driver_earnings("driverId","bookingId","grossAmount","commissionAmount","netAmount","createdAt") VALUES($1,$2,$3,$3::numeric*0.05,$3::numeric*0.95,COALESCE($4::timestamptz,clock_timestamp())) RETURNING *`,
          [driver, bid, amount, createdAt ?? null],
        )
      )[0];
    const cash = async (amount = 10000) => {
      const bid = randomUUID();
      await db.query(
        `INSERT INTO bookings(id,"tripId","cashReceivedAmount","cashReceivedAt","cashReceivedByDriverId") VALUES($1,$2,$3,clock_timestamp(),$4)`,
        [bid, trip, amount, driver],
      );
      return bid;
    };
    it('does not collect before explicit consent AND delivery; scopes contracts to driver', async () => {
      const { id } = await offer();
      await earning();
      expect((await credit(id)).paidMinor).toBe('0');
      await expect(service.detail(id, admin)).rejects.toThrow();
      await expect(
        service.activate(id, admin, {
          assetReference: 'test',
          deliveryReference: 'test',
        }),
      ).rejects.toThrow();
      await service.decide(id, driver, true);
      await earning();
      expect((await credit(id)).paidMinor).toBe('0');
      const own = await service.detail(id, driver);
      expect(own).not.toHaveProperty('requestPayload');
      expect(own).not.toHaveProperty('validationReference');
    });
    it('collects 5% separately, leaves original commission at 5%, replays safely, and caps principal', async () => {
      const id = await active(60000);
      const first = await earning();
      expect(first).toMatchObject({
        commissionAmount: '500.00',
        netAmount: '9500.00',
        assetRepaymentAmount: '500.00',
      });
      expect(earningForClient(first).netAmount).toBe(9000);
      await db.query(
        'UPDATE driver_earnings SET "grossAmount"="grossAmount" WHERE id=$1',
        [first.id],
      );
      expect((await credit(id)).paidMinor).toBe('50000');
      expect((await earning()).assetRepaymentAmount).toBe('100.00');
      expect((await credit(id)).status).toBe('settled');
      expect((await earning()).assetRepaymentAmount).toBe('0.00');
    });
    it('cannot activate the same physical material twice', async () => {
      const first = await active(10000);
      const second = await offer();
      await service.decide(second.id, driver, true);
      await expect(
        service.activate(second.id, admin, {
          assetReference: `test-phone-${first}`,
          deliveryReference: 'another-receipt',
        }),
      ).rejects.toThrow('déjà lié');
      expect((await credit(second.id)).status).toBe('accepted');
      await earning();
      expect((await credit(first)).status).toBe('settled');
      await expect(
        service.activate(second.id, admin, {
          assetReference: `TEST-PHONE-${first.toUpperCase()}`,
          deliveryReference: 'another-receipt',
        }),
      ).rejects.toThrow('déjà lié');
    });
    it('cash deducts funded balance only; remainder is due; recharge alone never repays', async () => {
      const id = await active();
      await db.query(
        'UPDATE wallet_accounts SET balance=25,"withdrawableBalance"=20,"reservedCashCommissionBalance"=5',
      );
      const bid = await cash();
      expect(await credit(id)).toMatchObject({
        paidMinor: '15000',
        dueMinor: '35000',
      });
      expect(
        (await db.query('SELECT balance FROM wallet_accounts'))[0].balance,
      ).toBe('10.00');
      await db.query(
        'UPDATE bookings SET "cashReceivedAmount"="cashReceivedAmount" WHERE id=$1',
        [bid],
      );
      await db.query(
        'UPDATE wallet_accounts SET balance=balance+100,"withdrawableBalance"="withdrawableBalance"+100',
      );
      expect(await credit(id)).toMatchObject({
        paidMinor: '15000',
        dueMinor: '35000',
      });
      const dto = { mutationId: randomUUID(), amountMinor: 40000 };
      await service.repay(id, driver, dto);
      await service.repay(id, driver, dto);
      expect(await credit(id)).toMatchObject({
        paidMinor: '55000',
        dueMinor: '0',
      });
      await expect(
        service.repay(id, driver, { ...dto, amountMinor: 50000 }),
      ).rejects.toThrow();
    });
    it('serializes concurrent repayments and never overdraws or overpays', async () => {
      const id = await active(100000);
      const dto = { mutationId: randomUUID(), amountMinor: 80000 };
      await Promise.all([
        service.repay(id, driver, dto),
        service.repay(id, driver, dto),
      ]);
      expect((await credit(id)).paidMinor).toBe('80000');
      const results = await Promise.allSettled([
        service.repay(id, driver, {
          mutationId: randomUUID(),
          amountMinor: 20000,
        }),
        service.repay(id, driver, {
          mutationId: randomUUID(),
          amountMinor: 20000,
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await credit(id)).toMatchObject({
        paidMinor: '100000',
        status: 'settled',
      });
    });
    it('later trip revenue repays existing cash dues and reversal restores them', async () => {
      const id = await active(10000);
      await db.query(
        'UPDATE wallet_accounts SET balance=0,"withdrawableBalance"=0',
      );
      await cash();
      await cash();
      expect(await credit(id)).toMatchObject({
        paidMinor: '0',
        dueMinor: '10000',
      });
      const row = await earning();
      expect(await credit(id)).toMatchObject({
        paidMinor: '10000',
        dueMinor: '0',
        status: 'settled',
      });
      await db.query(
        "UPDATE driver_earnings SET status='cancelled' WHERE id=$1",
        [row.id],
      );
      expect(await credit(id)).toMatchObject({
        paidMinor: '0',
        dueMinor: '10000',
        status: 'active',
      });
    });
    it('phone requests are idempotent and scoped to an active driver', async () => {
      const results = await Promise.all([
        service.request(driver, 'test'),
        service.request(driver, 'test'),
      ]);
      expect(results[0].id).toBe(results[1].id);
      expect((await service.requests(admin)).items).toHaveLength(0);
      await expect(db.transaction(m => new AssetCredits1780000124000().down(m.queryRunner!))).rejects.toThrow('archived');
      await offer();
      expect((await service.requests(driver)).items[0].status).toBe('offered');
    });
    it('global repayment is 5%, not 5% per loan; historical earnings excluded', async () => {
      const first = await active(10000);
      const second = await active();
      expect(
        (await earning(10000, randomUUID(), '2020-01-01')).assetRepaymentAmount,
      ).toBe('0.00');
      const row = await earning();
      expect(row.assetRepaymentAmount).toBe('500.00');
      expect((await credit(first)).paidMinor).toBe('10000');
      expect((await credit(second)).paidMinor).toBe('40000');
    });
    it('adjusts electronic earnings without mis-reversing a capped allocation', async () => {
      const id = await active(20000);
      const row = await earning();
      await db.query(
        'UPDATE driver_earnings SET "grossAmount"=8000,"commissionAmount"=400,"netAmount"=7600 WHERE id=$1',
        [row.id],
      );
      expect((await credit(id)).paidMinor).toBe('20000');
      await db.query(
        "UPDATE driver_earnings SET status='cancelled' WHERE id=$1",
        [row.id],
      );
      expect(await credit(id)).toMatchObject({
        paidMinor: '0',
        status: 'active',
      });
      await db.query(
        "UPDATE driver_earnings SET status='available' WHERE id=$1",
        [row.id],
      );
      expect((await credit(id)).paidMinor).toBe('20000');
    });
    it('blocks future products, blocked wallets and unverified identities', async () => {
      await expect(
        service.offer(admin, {
          mutationId: randomUUID(),
          driverId: driver,
          assetKind: 'vehicle',
          label: 'test vehicle',
          principalMinor: 10000,
          terms: 'test',
          validationReference: 'test',
        }),
      ).rejects.toThrow();
      const id = await active();
      await db.query('UPDATE wallet_accounts SET "withdrawalsBlocked"=true');
      await cash();
      expect(await credit(id)).toMatchObject({
        paidMinor: '0',
        dueMinor: '50000',
      });
      await expect(
        service.repay(id, driver, {
          mutationId: randomUUID(),
          amountMinor: 10000,
        }),
      ).rejects.toThrow();
      const pending = await offer();
      await db.query("UPDATE kyc_documents SET status='pending'");
      await expect(service.decide(pending.id, driver, true)).rejects.toThrow();
    });
    it('records a balanced audit ledger for every change', async () => {
      const id = await active();
      await earning();
      await cash();
      await service.repay(id, driver, {
        mutationId: randomUUID(),
        amountMinor: 10000,
      });
      const [ledger] = await db.query(
        'SELECT SUM("amountMinor") paid,SUM("dueDeltaMinor") due FROM asset_credit_entries WHERE "creditId"=$1',
        [id],
      );
      const c = await credit(id);
      expect(c.paidMinor).toBe(ledger.paid);
      expect(c.dueMinor).toBe(ledger.due);
      await expect(
        db.transaction((m) =>
          new AssetCredits1780000124000().down(m.queryRunner!),
        ),
      ).rejects.toThrow('archived');
    });
    it('HTTP + database: admin offer, owner consent, delivery, income and idempotent wallet repayment', async () => {
      const http = request(app.getHttpServer());
      await http.get('/asset-credits/mine').expect(401);
      await http
        .get('/partners/asset-credits/admin')
        .set('x-test-user', driver)
        .expect(403);
      const body = {
        mutationId: randomUUID(),
        driverId: driver,
        assetKind: 'phone',
        label: 'HTTP test phone',
        principalMinor: 100000,
        terms:
          'Contrat de test HTTP et PostgreSQL isolé. Consentement avant activation du crédit.',
        validationReference: 'test',
      };
      await http
        .post('/partners/asset-credits/admin')
        .set('x-test-user', driver)
        .send(body)
        .expect(403);
      const offered = await http
        .post('/partners/asset-credits/admin')
        .set('x-test-user', admin)
        .set('x-test-role', 'super_admin')
        .send(body)
        .expect(201);
      const id = offered.body.id;
      await http
        .post(`/asset-credits/mine/${id}/accept`)
        .set('x-test-user', driver)
        .send({ consent: false, policyVersion: 'asset-credit-v1' })
        .expect(400);
      await http
        .post(`/asset-credits/mine/${id}/accept`)
        .set('x-test-user', admin)
        .send({ consent: true, policyVersion: 'asset-credit-v1' })
        .expect(404);
      await http
        .post(`/asset-credits/mine/${id}/accept`)
        .set('x-test-user', driver)
        .send({ consent: true, policyVersion: 'asset-credit-v1' })
        .expect(201);
      await http
        .post(`/partners/asset-credits/admin/${id}/activate`)
        .set('x-test-user', admin)
        .set('x-test-role', 'super_admin')
        .send({ assetReference: 'test', deliveryReference: 'test' })
        .expect(201);
      await earning();
      const payment = { mutationId: randomUUID(), amountMinor: 50000 };
      await http
        .post(`/asset-credits/mine/${id}/repay`)
        .set('x-test-user', driver)
        .send(payment)
        .expect(201);
      const repeated = await http
        .post(`/asset-credits/mine/${id}/repay`)
        .set('x-test-user', driver)
        .send(payment)
        .expect(201);
      expect(repeated.body.replayed).toBe(true);
      const result = await http
        .get(`/asset-credits/mine/${id}`)
        .set('x-test-user', driver)
        .expect(200);
      expect(result.body).toMatchObject({
        status: 'settled',
        paidMinor: '100000',
        dueMinor: '0',
      });
      expect(result.body).not.toHaveProperty('requestPayload');
      await http
        .post(`/asset-credits/mine/${id}/repay`)
        .set('x-test-user', driver)
        .send({ ...payment, amountMinor: 20000 })
        .expect(409);
    });
  },
);
