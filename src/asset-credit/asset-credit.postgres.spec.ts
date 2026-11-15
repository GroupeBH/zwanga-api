import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { AssetCredits1780000124000 } from '../database/migrations/1780000124000-AssetCredits';
import { EquipmentAssetCredits1780000127000 } from '../database/migrations/1780000127000-EquipmentAssetCredits';
import { IntercityDriverCategory1780000128000 } from '../database/migrations/1780000128000-IntercityDriverCategory';
import { ContractAssetCreditRates1780000129000 } from '../database/migrations/1780000129000-ContractAssetCreditRates';
import { AssetCreditCostDisclosure1780000130000 } from '../database/migrations/1780000130000-AssetCreditCostDisclosure';
import { type AssetKind } from './asset-credit-products';
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
      CREATE TABLE users(id uuid PRIMARY KEY,"isDriver" boolean DEFAULT true,"isActive" boolean DEFAULT true,"driverCategory" text CONSTRAINT "CHK_users_driver_category" CHECK("driverCategory" IS NULL OR "driverCategory" IN ('private','transport')));
      CREATE TABLE kyc_documents(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"userId" uuid,status text,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE trips(id uuid PRIMARY KEY,"driverId" uuid);
      CREATE TABLE bookings(id uuid PRIMARY KEY,"tripId" uuid,"paymentMode" text DEFAULT 'cash',status text DEFAULT 'completed',"paymentCurrency" text DEFAULT 'CDF',"cashReceivedAt" timestamptz,"cashReceivedAmount" numeric(12,2),"cashReceivedByDriverId" uuid);
      CREATE TABLE wallet_accounts(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"userId" uuid,type text DEFAULT 'points',balance numeric(12,2) DEFAULT 0,"withdrawableBalance" numeric(12,2) DEFAULT 0,"reservedCashCommissionBalance" numeric(12,2) DEFAULT 0,"withdrawalsBlocked" boolean DEFAULT false,currency text DEFAULT 'PTS',"updatedAt" timestamptz DEFAULT now(), UNIQUE("userId",type), CHECK(balance>=0 AND "withdrawableBalance">=0 AND "withdrawableBalance"<=balance));
      CREATE TABLE wallet_ledger_entries(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"accountId" uuid,"userId" uuid,"accountType" text,type text,amount numeric(12,2),"withdrawableAmount" numeric(12,2),"balanceAfter" numeric(12,2),currency text,"relatedEntityType" text,"relatedEntityId" uuid,description text,CONSTRAINT "CHK_wallet_ledger_type" CHECK(type IN ('top_up')));
      CREATE TABLE driver_earnings(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"driverId" uuid,"bookingId" uuid UNIQUE,"grossAmount" numeric(12,2),"netAmount" numeric(12,2),"commissionAmount" numeric(12,2),currency text DEFAULT 'CDF',status text DEFAULT 'available',"createdAt" timestamptz DEFAULT clock_timestamp(), CHECK("grossAmount"="netAmount"+"commissionAmount"));`);
      await db.transaction((m) =>
        new AssetCredits1780000124000().up(m.queryRunner!),
      );
      await db.transaction(m => new EquipmentAssetCredits1780000127000().up(m.queryRunner!));
      await db.transaction(m => new IntercityDriverCategory1780000128000().up(m.queryRunner!));
      await db.transaction(m => new ContractAssetCreditRates1780000129000().up(m.queryRunner!));
      await db.transaction(m => new AssetCreditCostDisclosure1780000130000().up(m.queryRunner!));
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
        'TRUNCATE asset_credit_rate_allocations,asset_credit_rate_sources,asset_credit_wallet_mutations,asset_credit_sources,asset_credit_entries,asset_credit_events,asset_credits,asset_credit_requests,driver_earnings,wallet_ledger_entries,wallet_accounts,bookings,trips,kyc_documents,users',
      );
      driver = randomUUID();
      await db.query('UPDATE asset_credit_products SET enabled=true');
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
    it('discloses fixed fees and minimums, requires updated consent and freezes agreed cost terms', async () => {
      const dto = { mutationId: randomUUID(), driverId: driver, assetKind: 'phone' as const,
        label: 'Bien de test', principalMinor: 110000, cashPriceMinor: 100000, creditFeeMinor: 10000,
        installmentCount: 4, installmentPeriod: 'week' as const, repaymentBps: 500,
        terms: 'Conditions isolées : prix et frais fixes, quatre échéances minimums après remise du bien.', validationReference: 'test-validation' };
      const { body: result } = await request(app.getHttpServer()).post('/asset-credits/admin')
        .set('x-test-user', admin).set('x-test-role', 'super_admin').send(dto).expect(201);
      const detail = await service.detail(result.id, driver);
      expect(detail.creditFeeMinor).toBe('10000');
      expect(detail.installments).toHaveLength(4);
      expect(detail.installments[0].dueAt).toBeNull();
      const consent = { consent: true, policyVersion: 'asset-credit-v2', expectedTotalRepaymentBps: 500 };
      await request(app.getHttpServer()).post(`/asset-credits/mine/${result.id}/accept`)
        .set('x-test-user', driver).send(consent).expect(409);
      await request(app.getHttpServer()).post(`/asset-credits/mine/${result.id}/accept`)
        .set('x-test-user', driver).send({ ...consent, costDisclosureVersion: 'asset-credit-cost-v1' }).expect(201);
      await service.activate(result.id, admin, { deliveryReference: 'test-delivery', assetReference: 'test-serial' });
      expect((await service.detail(result.id, driver)).installments[0].dueAt).not.toBeNull();
      await service.repay(result.id, driver, { mutationId: randomUUID(), amountMinor: 500 });
      expect((await service.detail(result.id, driver)).installments[0].remainingMinor).toBe(27000);
      await expect(db.query('UPDATE asset_credits SET "creditFeeMinor"=20000,"principalMinor"=120000 WHERE id=$1', [result.id])).rejects.toThrow('ASSET_COST_IMMUTABLE');
      await expect(db.query('UPDATE asset_credits SET "installmentCount"=5 WHERE id=$1', [result.id])).rejects.toThrow('ASSET_COST_IMMUTABLE');
      await expect(db.query('UPDATE asset_credits SET "activatedAt"=now() WHERE id=$1', [result.id])).rejects.toThrow('ASSET_COST_IMMUTABLE');
      await expect(db.transaction(m => new AssetCreditCostDisclosure1780000130000().down(m.queryRunner!))).rejects.toThrow('must be preserved');
      await expect(service.offer(admin, { ...dto, mutationId: randomUUID(), creditFeeMinor: 1 })).rejects.toThrow();
      await expect(service.offer(admin, { ...dto, creditFeeMinor: 9000, cashPriceMinor: 101000 })).rejects.toThrow();
    });
    const offer = async (principalMinor = 1000000, assetKind: AssetKind = 'phone', repaymentBps?: number) => {
      const result = await service.offer(admin, {
        mutationId: randomUUID(),
        driverId: driver,
        assetKind,
        label: 'Téléphone de test',
        principalMinor,
        repaymentBps: repaymentBps ?? 500,
        terms:
          'Contrat de test isolé. Aucun intérêt ni frais supplémentaire. Matériel remis après accord.',
        validationReference: 'test-validation',
      });
      // Historical v1 fixtures explicitly preserve the old pooled rule; new HTTP offers are v2.
      if (repaymentBps === undefined) await db.query(`UPDATE asset_credits SET "policyVersion"='asset-credit-v1' WHERE id=$1`, [result.id]);
      return result;
    };
    const accept = async (id: string) => {
      const detail = await service.detail(id, driver);
      return service.decide(id, driver, true, { consent: true, policyVersion: detail.policyVersion, expectedTotalRepaymentBps: detail.totalRepaymentBps });
    };
    const active = async (amount = 1000000, assetKind: AssetKind = 'phone', repaymentBps?: number) => {
      const { id } = await offer(amount, assetKind, repaymentBps);
      await accept(id);
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
      const second = await active(1000000, 'helmet');
      const third = await active(1000000, 'gps_tracker');
      expect(
        (await earning(10000, randomUUID(), '2020-01-01')).assetRepaymentAmount,
      ).toBe('0.00');
      const row = await earning();
      expect(row.assetRepaymentAmount).toBe('500.00');
      expect((await credit(first)).paidMinor).toBe('10000');
      expect((await credit(second)).paidMinor).toBe('40000');
      expect((await credit(third)).paidMinor).toBe('0');
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
          repaymentBps: 500,
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
    it.each(['phone', 'helmet', 'gps_tracker', 'delivery_equipment', 'equipment', 'vehicle'] as const)('HTTP + database %s: application, admin offer, owner consent, delivery, income and wallet repayment', async assetKind => {
      const http = request(app.getHttpServer());
      const application = await http.post('/asset-credits/requests').set('x-test-user', driver)
        .send({ assetKind, notes: 'Matériel de test isolé' }).expect(201);
      const list = await http.get('/asset-credits/requests').set('x-test-user', driver).expect(200);
      expect(list.body.items).toEqual([expect.objectContaining({ id: application.body.id, assetKind, status: 'submitted' })]);
      const other = await http.get('/asset-credits/requests').set('x-test-user', admin).expect(200);
      expect(other.body.items).toEqual([]);
      await http.get('/asset-credits/mine').expect(401);
      await http
        .get('/partners/asset-credits/admin')
        .set('x-test-user', driver)
        .expect(403);
      const body = {
        mutationId: randomUUID(),
        driverId: driver,
        assetKind,
        label: 'HTTP test phone',
        principalMinor: 100000,
        repaymentBps: 500,
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
      expect((await service.requests(driver)).items[0].status).toBe('offered');
      await http
        .post(`/asset-credits/mine/${id}/accept`)
        .set('x-test-user', driver)
        .send({ consent: false, policyVersion: 'asset-credit-v2', expectedTotalRepaymentBps: 500 })
        .expect(400);
      await http
        .post(`/asset-credits/mine/${id}/accept`)
        .set('x-test-user', admin)
        .send({ consent: true, policyVersion: 'asset-credit-v2', expectedTotalRepaymentBps: 500 })
        .expect(404);
      await http.post(`/asset-credits/mine/${id}/accept`).set('x-test-user', driver)
        .send({ consent: true, policyVersion: 'asset-credit-v1' }).expect(409);
      await http.post(`/asset-credits/mine/${id}/accept`).set('x-test-user', driver)
        .send({ consent: true, policyVersion: 'asset-credit-v2' }).expect(409);
      await http
        .post(`/asset-credits/mine/${id}/accept`)
        .set('x-test-user', driver)
        .send({ consent: true, policyVersion: 'asset-credit-v2', expectedTotalRepaymentBps: 500 })
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
        assetKind,
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
    it('HTTP catalogue and SQL gates agree: paused products, invalid kinds and inactive drivers are refused', async () => {
      const http = request(app.getHttpServer());
      await http.get('/asset-credits/products').expect(401);
      await db.query("UPDATE asset_credit_products SET enabled=false WHERE kind='vehicle'");
      const catalogue = await http.get('/asset-credits/products').set('x-test-user', driver).expect(200);
      expect(catalogue.body.canRequest).toBe(true);
      expect(catalogue.body.items.filter(p => p.enabled).map(p => p.kind)).toEqual(['phone', 'helmet', 'gps_tracker', 'delivery_equipment', 'equipment']);
      for (const assetKind of ['vehicle', 'invalid']) {
        await http.post('/asset-credits/requests').set('x-test-user', driver).send({ assetKind, notes: '' }).expect(assetKind === 'vehicle' ? 409 : 400);
      }
      await http.post('/asset-credits/requests').set('x-test-user', driver).send({ assetKind: 'equipment', notes: '  ' }).expect(400);
      await db.query("UPDATE asset_credit_products SET enabled=false WHERE kind='helmet'");
      const paused = await http.get('/asset-credits/products').set('x-test-user', driver).expect(200);
      expect(paused.body.items.find(p => p.kind === 'helmet').enabled).toBe(false);
      await expect(service.request(driver, '', 'helmet')).rejects.toThrow();
      await expect(offer(10000, 'helmet')).rejects.toThrow();
      await db.query('UPDATE users SET "isDriver"=false WHERE id=$1', [driver]);
      expect((await service.products(driver)).canRequest).toBe(false);
      await expect(service.request(driver, '', 'phone')).rejects.toThrow();
    });
    it('concurrent applications coalesce per driver AND kind, without hiding other equipment', async () => {
      const [a, b, other] = await Promise.all([service.request(driver, '', 'helmet'), service.request(driver, '', 'helmet'), service.request(driver, '', 'gps_tracker')]);
      expect(a.id).toBe(b.id); expect(other.id).not.toBe(a.id);
      await offer(10000, 'helmet');
      const rows = (await service.requests(driver)).items;
      expect(rows.find(r => r.assetKind === 'helmet').status).toBe('offered');
      expect(rows.find(r => r.assetKind === 'gps_tracker').status).toBe('submitted');
      await expect(db.transaction(m => new EquipmentAssetCredits1780000127000().down(m.queryRunner!))).rejects.toThrow('preserved');
    });
    it('equipment migration can round-trip without dossiers and preserves phone and vehicle flags', async () => {
      await db.query("UPDATE asset_credit_products SET enabled=false WHERE kind='phone'");
      await db.transaction(m => new EquipmentAssetCredits1780000127000().down(m.queryRunner!));
      await db.transaction(m => new EquipmentAssetCredits1780000127000().up(m.queryRunner!));
      const products = (await service.products(driver)).items;
      expect(products.find(p => p.kind === 'phone')?.enabled).toBe(false);
      expect(products.find(p => p.kind === 'vehicle')?.enabled).toBe(true);
      expect(products.find(p => p.kind === 'equipment')?.enabled).toBe(true);
    });
    it('adds individual equipment and vehicle percentages, caps each principal and does not replay a debit', async () => {
      const phone = await active(20000, 'phone', 500);
      const vehicle = await active(1000000, 'vehicle', 1500);
      const row = await earning();
      expect(row.assetRepaymentAmount).toBe('1700.00');
      expect(row.commissionAmount).toBe('500.00');
      expect(earningForClient(row).netAmount).toBe(7800);
      expect((await credit(phone)).paidMinor).toBe('20000');
      expect((await credit(vehicle)).paidMinor).toBe('150000');
      await db.query('UPDATE driver_earnings SET "grossAmount"="grossAmount" WHERE id=$1', [row.id]);
      expect((await credit(vehicle)).paidMinor).toBe('150000');
      expect((await earning()).assetRepaymentAmount).toBe('1500.00');
    });
    it('keeps legacy credits pooled while adding new rates and reverses only the correct allocations', async () => {
      const first = await active(10000);
      const second = await active(1000000, 'helmet');
      const vehicle = await active(1000000, 'vehicle', 1500);
      const row = await earning();
      expect(row.assetRepaymentAmount).toBe('2000.00');
      expect((await credit(second)).paidMinor).toBe('40000');
      expect((await credit(vehicle)).paidMinor).toBe('150000');
      await db.query("UPDATE driver_earnings SET status='cancelled' WHERE id=$1", [row.id]);
      for (const id of [first, second, vehicle]) expect((await credit(id)).paidMinor).toBe('0');
    });
    it('cash allocates the funded balance once per contract and keeps unfunded amounts due', async () => {
      const phone = await active(1000000, 'phone', 500);
      const vehicle = await active(1000000, 'vehicle', 1500);
      const bid = await cash();
      expect(await credit(phone)).toMatchObject({ paidMinor: '50000', dueMinor: '0' });
      expect(await credit(vehicle)).toMatchObject({ paidMinor: '50000', dueMinor: '100000' });
      await db.query('UPDATE wallet_accounts SET balance=100,"withdrawableBalance"=100');
      await db.query('UPDATE bookings SET "cashReceivedAmount"="cashReceivedAmount" WHERE id=$1', [bid]);
      expect((await credit(vehicle)).paidMinor).toBe('50000');
      await service.repay(vehicle, driver, { mutationId: randomUUID(), amountMinor: 100000 });
      expect(await credit(vehicle)).toMatchObject({ paidMinor: '150000', dueMinor: '0' });
    });
    it('adjusts v2 income and restores cash dues on electronic reversal without charging later contracts', async () => {
      const id = await active(100000, 'phone', 1000);
      await db.query('UPDATE wallet_accounts SET balance=0,"withdrawableBalance"=0');
      await cash();
      const row = await earning();
      expect(await credit(id)).toMatchObject({ status: 'settled', paidMinor: '100000', dueMinor: '0' });
      const later = await active(1000000, 'vehicle', 2000);
      await db.query('UPDATE driver_earnings SET "grossAmount"=5000,"commissionAmount"=250,"netAmount"=4750 WHERE id=$1', [row.id]);
      expect(await credit(id)).toMatchObject({ paidMinor: '50000', dueMinor: '50000' });
      expect((await credit(later)).paidMinor).toBe('0');
      await db.query("UPDATE driver_earnings SET status='cancelled' WHERE id=$1", [row.id]);
      expect(await credit(id)).toMatchObject({ paidMinor: '0', dueMinor: '100000' });
      const [ledger] = await db.query('SELECT SUM("amountMinor") paid,SUM("dueDeltaMinor") due FROM asset_credit_entries WHERE "creditId"=$1', [id]);
      expect(ledger).toEqual({ paid: '0', due: '100000' });
    });
    it('serializes acceptances, rejects stale totals, and never accepts a cumulative rate above available income', async () => {
      const a = await offer(1000000, 'phone', 5000), b = await offer(1000000, 'vehicle', 5000);
      const consent = { consent: true, policyVersion: 'asset-credit-v2', expectedTotalRepaymentBps: 5000 };
      const results = await Promise.allSettled([service.decide(a.id, driver, true, consent), service.decide(b.id, driver, true, consent)]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const small = await offer(1000000, 'helmet', 1000);
      await expect(service.decide(small.id, driver, true, { ...consent, expectedTotalRepaymentBps: 1000 })).rejects.toThrow('changé');
      await accept(small.id);
      expect((await service.detail(small.id, driver)).totalRepaymentBps).toBe(6000);
    });
    it('validates rate bounds, prevents zero-default offers and refuses a destructive rollback', async () => {
      for (const rate of [0, -1, 9501, 1.5, NaN]) await expect(offer(100000, 'phone', rate)).rejects.toThrow('pourcentage');
      const id = (await offer(100000, 'vehicle', 1250)).id;
      expect(await service.detail(id, driver)).toMatchObject({ repaymentBps: 1250, totalRepaymentBps: 1250, policyVersion: 'asset-credit-v2' });
      await expect(db.transaction(m => new ContractAssetCreditRates1780000129000().down(m.queryRunner!))).rejects.toThrow('preserved');
    });
    it('rate migration round-trips without contracts, preserving other product flags', async () => {
      await db.query("UPDATE asset_credit_products SET enabled=false WHERE kind='phone'");
      await db.transaction(m => new ContractAssetCreditRates1780000129000().down(m.queryRunner!));
      await db.transaction(m => new ContractAssetCreditRates1780000129000().up(m.queryRunner!));
      const products = (await service.products(driver)).items;
      expect(products.find(p => p.kind === 'phone')?.enabled).toBe(false);
      expect(products.find(p => p.kind === 'vehicle')?.enabled).toBe(true);
    });
    it('a historical correction cannot let cumulative deductions exceed the actual net income', async () => {
      const first = await active(800000, 'phone', 8000);
      const initial = await earning();
      expect((await credit(first)).status).toBe('settled');
      const second = await active(10000000, 'vehicle', 8000);
      await db.query("UPDATE driver_earnings SET status='cancelled' WHERE id=$1", [initial.id]);
      const next = await earning();
      expect(next.assetRepaymentAmount).toBe('9500.00');
      expect((await credit(first)).paidMinor).toBe('800000');
      expect((await credit(second)).paidMinor).toBe('150000');
      await db.query('UPDATE driver_earnings SET "grossAmount"="grossAmount" WHERE id=$1', [next.id]);
      expect((await credit(second)).paidMinor).toBe('150000');
    });
    it('snapshots exclude a credit settled before the trip even if another trip later reopens it', async () => {
      const first = await active(50000, 'phone', 500);
      const original = await earning();
      const whileSettled = await earning();
      expect(whileSettled.assetRepaymentAmount).toBe('0.00');
      await db.query("UPDATE driver_earnings SET status='cancelled' WHERE id=$1", [original.id]);
      await db.query('UPDATE driver_earnings SET "grossAmount"="grossAmount" WHERE id=$1', [whileSettled.id]);
      expect((await credit(first)).paidMinor).toBe('0');
    });
    it('HTTP rejects absent, excessive and fractional basis-point rates before creating an offer', async () => {
      for (const repaymentBps of [undefined, 0, 9501, 500.5]) {
        await request(app.getHttpServer()).post('/partners/asset-credits/admin')
          .set('x-test-user', admin).set('x-test-role', 'super_admin')
          .send({ mutationId: randomUUID(), driverId: driver, assetKind: 'phone', label: 'Test phone',
            principalMinor: 100000, repaymentBps, terms: 'Conditions explicites de test sans aucun envoi ni contrat réel.', validationReference: 'test' }).expect(400);
      }
      expect((await service.list(driver)).items).toHaveLength(0);
    });
    it('intercity migration accepts the category without classifying legacy users; rollback preserves profiles', async () => {
      expect((await db.query('SELECT "driverCategory" FROM users WHERE id=$1', [driver]))[0].driverCategory).toBeNull();
      await db.query('UPDATE users SET "driverCategory"=$1 WHERE id=$2', ['intercity', driver]);
      await expect(db.query('UPDATE users SET "driverCategory"=$1 WHERE id=$2', ['invalid', driver])).rejects.toThrow();
      await expect(db.transaction(m => new IntercityDriverCategory1780000128000().down(m.queryRunner!))).rejects.toThrow('preserved');
      await db.query('UPDATE users SET "driverCategory"=NULL WHERE id=$1', [driver]);
      await db.transaction(m => new IntercityDriverCategory1780000128000().down(m.queryRunner!));
      await expect(db.query('UPDATE users SET "driverCategory"=$1 WHERE id=$2', ['intercity', driver])).rejects.toThrow();
      await db.transaction(m => new IntercityDriverCategory1780000128000().up(m.queryRunner!));
      await db.query('UPDATE users SET "driverCategory"=$1 WHERE id=$2', ['intercity', driver]);
    });
  },
);
