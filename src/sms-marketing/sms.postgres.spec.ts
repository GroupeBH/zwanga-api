import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { CanonicalPhoneIdentity1780000119000 } from '../database/migrations/1780000119000-CanonicalPhoneIdentity';
import { SmsMarketing1780000149000 } from '../database/migrations/1780000149000-SmsMarketing';
import { SmsRepository } from './sms.repository';
import { SmsMarketingConfig } from './sms.config';
import { SmsAudienceService } from './sms.audience';
import { SmsCampaignsService } from './sms.campaigns';
import { SmsDeliveryService } from './sms.delivery';
import { SmsOptOutsService } from './sms.opt-outs';
import { SmsAudienceDto, SmsPageDto } from './sms.dto';
import { MobishastraMarketingTransport } from './mobishastra-marketing.transport';
import { renderSms, smsLength } from './sms.policy';

const bin = process.env.AUDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'SMS campaigns: isolated PostgreSQL, provider simulated',
  () => {
    jest.setTimeout(90000);
    const cluster = new IsolatedPostgres(bin!);
    const migration = new SmsMarketing1780000149000();
    let db: DataSource,
      config: SmsMarketingConfig,
      repository: SmsRepository,
      audience: SmsAudienceService;
    let campaigns: SmsCampaignsService,
      delivery: SmsDeliveryService,
      optOuts: SmsOptOutsService;
    const transport = {
      configured: jest.fn(() => true),
      send: jest.fn(async (..._args: any[]) => ({
        accepted: true as boolean,
        code: 'PROVIDER_REJECTED',
      })),
    };
    let actor: string, marketer: string, passenger: string, driver: string;
    const standard = () => new SmsAudienceDto();
    const codeOf = (e: any) => e.getResponse?.().code;
    async function rejectCode(p: Promise<unknown>, code: string) {
      await expect(
        p.then(
          () => null,
          (e) => codeOf(e),
        ),
      ).resolves.toBe(code);
    }
    async function user(
      role = 'passenger',
      phone = '+243900000001',
      extra: Record<string, unknown> = {},
    ) {
      const values = {
        id: randomUUID(),
        phone,
        role,
        firstName: 'Jean',
        lastName: 'Test',
        isActive: true,
        isPhoneVerified: true,
        status: 'active',
        ...extra,
      };
      const fields = Object.keys(values);
      await db.query(
        `INSERT INTO users(${fields.map((f) => '"' + f + '"').join(',')}) VALUES(${fields.map((_, i) => '$' + (i + 1)).join(',')})`,
        Object.values(values),
      );
      return values.id;
    }
    async function resetBudget() {
      await db.query(
        `UPDATE sms_runtime SET "nextSendAt"=now()-interval '1 second',used=0`,
      );
    }
    async function draft(a = standard(), message = 'Bonjour !') {
      return campaigns.create(actor, {
        requestId: randomUUID(),
        name: 'Test',
        message,
        audience: a,
      });
    }
    async function tested() {
      const c = await draft();
      await delivery.test(actor, c.id, {
        revision: c.revision,
        requestId: randomUUID(),
      });
      await resetBudget();
      return c;
    }
    async function launched() {
      const c = await tested();
      return campaigns.launch(actor, c.id, {
        revision: c.revision,
        requestId: randomUUID(),
        scheduledAt: null,
        expectedRecipients: 2,
      });
    }
    beforeAll(async () => {
      db = await cluster.start();
      await db.query(`CREATE TABLE users(id uuid PRIMARY KEY,phone text,role text NOT NULL,"firstName" text,"lastName" text,
      "isActive" boolean NOT NULL DEFAULT true,"isPhoneVerified" boolean NOT NULL DEFAULT true,status text NOT NULL DEFAULT 'active',
      "deletedAt" timestamptz,"lastLoginAt" timestamp,"createdAt" timestamp NOT NULL DEFAULT now());
      CREATE TABLE trips(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"driverId" uuid,status text);
      CREATE TABLE bookings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"passengerId" uuid,"tripId" uuid,status text);
      CREATE TABLE subscriptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"userId" uuid,status text,"startDate" timestamptz,"endDate" timestamptz);
      CREATE TABLE kyc_documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"userId" uuid,status text,"createdAt" timestamptz DEFAULT now());`);
      const q = db.createQueryRunner();
      await new CanonicalPhoneIdentity1780000119000().up(q);
      // Permit synthetic legacy invalid/duplicate identities only in this disposable fixture.
      await db.query('ALTER TABLE users DISABLE TRIGGER USER');
      await migration.up(q);
      await q.release();
      config = new SmsMarketingConfig(
        new ConfigService({
          SMS_MARKETING_ENABLED: 'true',
          SMS_MARKETING_LINK_HOST: 'z.test',
          SMS_MARKETING_OPT_OUT_BASE_URL: 'https://z.test/s/',
        }),
      );
      jest.spyOn(config, 'open').mockReturnValue(true);
      repository = new SmsRepository(db, config);
      audience = new SmsAudienceService(config);
      campaigns = new SmsCampaignsService(
        repository,
        audience,
        config,
        transport as unknown as MobishastraMarketingTransport,
      );
      delivery = new SmsDeliveryService(
        repository,
        campaigns,
        config,
        transport as unknown as MobishastraMarketingTransport,
      );
      optOuts = new SmsOptOutsService(repository);
    });
    afterAll(async () => {
      await delivery?.onModuleDestroy();
      await cluster.stop();
    });
    beforeEach(async () => {
      await db.query(
        'TRUNCATE sms_audit,sms_intents,sms_test_sends,sms_opt_outs,sms_campaign_recipients,sms_campaigns,bookings,trips,subscriptions,kyc_documents,users CASCADE',
      );
      await db.query(
        `UPDATE sms_runtime SET "pauseReason"=NULL,failures=0,used=0,"nextSendAt"=now()-interval '1 second'`,
      );
      actor = await user('admin', '+243900000010');
      marketer = await user('marketer', '+243900000011');
      passenger = await user();
      driver = await user('driver', '+243900000002');
      transport.send
        .mockReset()
        .mockResolvedValue({ accepted: true, code: '' });
      transport.configured.mockReturnValue(true);
    });
    it.each([
      '',
      'hello',
      'éèà€',
      '🚗'.repeat(40),
      'ê' + 'a'.repeat(70),
      '^'.repeat(81),
    ])(
      'SQL counting agrees with the admin-compatible policy: %s',
      async (text) => {
        const [r] = await db.query('SELECT sms_segments($1) n', [text]);
        expect(r.n).toBe(smsLength(text).segments);
      },
    );
    it.each([
      null,
      '',
      'Jean Paul',
      'Émilie Dupont',
      'a'.repeat(30),
      '\\1',
      '$&',
      '\tJean Paul\n',
      '😀'.repeat(25),
    ])('SQL rendering matches the backend: %s', async (name) => {
      const [r] = await db.query('SELECT sms_render($1,$2,$3) text', [
        'Bonjour {prenom},',
        name,
        ' Stop',
      ]);
      expect(r.text).toBe(renderSms('Bonjour {prenom},', name, ' Stop'));
    });
    it('freezes the same SQL snapshot as the estimate despite a concurrent registration', async () => {
      const c = await tested();
      const original = audience.estimate.bind(audience);
      const estimate = jest
        .spyOn(audience, 'estimate')
        .mockImplementationOnce(async (...args) => {
          const result = await original(...args);
          await user('passenger', '+243900000003');
          return result;
        });
      try {
        const result = await campaigns.launch(actor, c.id, {
          revision: 1,
          requestId: randomUUID(),
          scheduledAt: null,
          expectedRecipients: 2,
        });
        expect(result.estimate.recipients).toBe(2);
        expect(result.stats.recipients).toBe(2);
      } finally {
        estimate.mockRestore();
      }
    });
    it('runs a reversible schema migration', async () => {
      const q = db.createQueryRunner();
      await migration.down(q);
      await migration.up(q);
      await q.release();
      expect(
        (await db.query("SELECT to_regclass('sms_campaigns') name"))[0].name,
      ).toBe('sms_campaigns');
    });
    it('estimates only public active accounts and returns no personal data', async () => {
      const result = await campaigns.estimate(actor, {
        audience: standard(),
        message: 'Salut',
      });
      expect(result.recipients).toBe(2);
      expect(result.segments).toBe(2);
      expect(result.credits).toBe(2);
      expect(JSON.stringify(result)).not.toMatch(/Jean|243900/);
    });
    it('counts exclusions once in the prescribed order', async () => {
      await db.query(
        'UPDATE users SET "isActive"=false,"isPhoneVerified"=false,phone=NULL WHERE id=$1',
        [passenger],
      );
      await user('passenger', null as any);
      await user('passenger', 'invalid');
      await user('passenger', '+243900000003', { isPhoneVerified: false });
      await optOuts.add(actor, {
        phone: '+243900000003',
        reason: 'demande',
        source: 'team',
      });
      await optOuts.add(actor, {
        phone: '+243900000002',
        reason: 'demande',
        source: 'team',
      });
      const result = await campaigns.estimate(actor, {
        audience: standard(),
        message: 'Salut',
      });
      expect(result.recipients).toBe(0);
      expect(result.excluded).toMatchObject({
        inactiveAccount: 1,
        noPhone: 1,
        invalidPhone: 1,
        unverifiedPhone: 1,
        optedOut: 1,
      });
    });
    it('normalizes known phones, excludes unknowns, counts duplicates and overrides filters', async () => {
      await db.query('UPDATE users SET phone=$2 WHERE id=$1', [
        passenger,
        '0900000001',
      ]);
      const a = {
        ...standard(),
        roles: ['driver'],
        phones: ['+243900000001', '+243900000001', '+243900000099'],
      };
      const result = await campaigns.estimate(actor, {
        audience: a,
        message: 'Salut',
      });
      expect(result.recipients).toBe(1);
      expect(result.excluded).toMatchObject({
        duplicates: 1,
        unknownPhones: 1,
      });
      expect(
        (
          await campaigns.estimate(actor, {
            audience: { ...a, phones: [] },
            message: 'Salut',
          })
        ).recipients,
      ).toBe(0);
    });
    it('filters roles, login activity, registration dates, trips, Pro and latest KYC', async () => {
      await db.query(
        `UPDATE users SET "lastLoginAt"=now(),"createdAt"='2026-11-26T23:15:00Z' WHERE id=$1`,
        [driver],
      );
      await db.query(
        `INSERT INTO trips("driverId",status) VALUES($1,'completed')`,
        [driver],
      );
      await db.query(
        `INSERT INTO subscriptions("userId",status,"startDate","endDate") VALUES($1,'active',now()-interval '1 day',now()+interval '1 day')`,
        [driver],
      );
      await db.query(
        `INSERT INTO kyc_documents("userId",status,"createdAt") VALUES($1,'pending',now()-interval '1 day'),($1,'approved',now())`,
        [driver],
      );
      const estimate = async (a: Partial<SmsAudienceDto>) =>
        (
          await campaigns.estimate(actor, {
            audience: { ...standard(), ...a },
            message: 'Salut',
          })
        ).recipients;
      expect(await estimate({ roles: ['driver'] })).toBe(1);
      expect(await estimate({ activeWithinDays: 3 })).toBe(1);
      expect(await estimate({ inactiveForDays: 3 })).toBe(1);
      expect(
        await estimate({
          roles: ['driver'],
          signedUpFrom: '2026-11-27',
          signedUpTo: '2026-11-27',
        }),
      ).toBe(1);
      expect(
        await estimate({ roles: ['driver'], signedUpTo: '2026-11-26' }),
      ).toBe(0);
      expect(await estimate({ trips: 'atLeastOne' })).toBe(1);
      expect(await estimate({ trips: 'none' })).toBe(1);
      expect(await estimate({ proSubscription: 'active' })).toBe(1);
      expect(await estimate({ proSubscription: 'none' })).toBe(0);
      expect(await estimate({ kyc: 'approved' })).toBe(1);
      expect(await estimate({ kyc: 'pending' })).toBe(0);
      const [{ id: tripId }] = await db.query(`SELECT id FROM trips LIMIT 1`);
      await db.query(
        `INSERT INTO bookings("passengerId","tripId",status) VALUES($1,$2,'completed')`,
        [passenger, tripId],
      );
      expect(
        await estimate({ roles: ['passenger'], trips: 'atLeastOne' }),
      ).toBe(1);
    });
    it('deduplicates draft creation concurrently and rejects changed request contents', async () => {
      const d = {
        requestId: randomUUID(),
        name: 'Test',
        message: 'Salut',
        audience: standard(),
      };
      const [a, b] = await Promise.all([
        campaigns.create(actor, d),
        campaigns.create(actor, d),
      ]);
      expect(a.id).toBe(b.id);
      await rejectCode(
        campaigns.create(actor, { ...d, message: 'Autre' }),
        'SMS_IDEMPOTENCY_CONFLICT',
      );
    });
    it('requires the tested current revision and invalidates it on edit', async () => {
      const c = await draft();
      const payload = {
        revision: 1,
        requestId: randomUUID(),
        scheduledAt: null,
        expectedRecipients: 2,
      };
      await rejectCode(
        campaigns.launch(actor, c.id, payload),
        'SMS_TEST_REQUIRED',
      );
      await delivery.test(actor, c.id, {
        revision: 1,
        requestId: randomUUID(),
      });
      const changed = await campaigns.update(actor, c.id, {
        revision: 1,
        name: 'New',
        message: 'Bonjour',
        audience: standard(),
      });
      expect(changed.test).toBeNull();
      expect(changed.revision).toBe(2);
      await rejectCode(
        campaigns.launch(actor, c.id, payload),
        'SMS_REVISION_CONFLICT',
      );
      expect(
        (
          await db.query('SELECT count(*)::int n FROM sms_campaign_recipients')
        )[0].n,
      ).toBe(0);
    });
    it('rejects drift without any effect and snapshots idempotent launches', async () => {
      const c = await tested();
      await rejectCode(
        campaigns.launch(actor, c.id, {
          revision: 1,
          requestId: randomUUID(),
          scheduledAt: null,
          expectedRecipients: 100,
        }),
        'SMS_AUDIENCE_CHANGED',
      );
      expect((await campaigns.get(actor, c.id)).status).toBe('draft');
      const payload = {
        revision: 1,
        requestId: randomUUID(),
        scheduledAt: null,
        expectedRecipients: 2,
      };
      const a = await campaigns.launch(actor, c.id, payload);
      const b = await campaigns.launch(actor, c.id, payload);
      expect(a.id).toBe(b.id);
      expect(a.stats.recipients).toBe(2);
      await user('passenger', '+243900000003');
      expect((await campaigns.get(actor, c.id)).stats.recipients).toBe(2);
    });
    it('scheduled campaigns snapshot on start, not at scheduling time', async () => {
      const c = await tested();
      await campaigns.launch(actor, c.id, {
        revision: 1,
        requestId: randomUUID(),
        scheduledAt: new Date(Date.now() + 600000).toISOString(),
        expectedRecipients: 2,
      });
      expect((await campaigns.get(actor, c.id)).stats.recipients).toBe(0);
      await user('passenger', '+243900000003');
      await db.query(
        'UPDATE sms_campaigns SET "scheduledAt"=now() WHERE id=$1',
        [c.id],
      );
      await delivery.startScheduled();
      expect((await campaigns.get(actor, c.id)).stats.recipients).toBe(3);
    });
    it('test sends are tied to the actor and request, never repeated on replay', async () => {
      const c = await draft();
      const dto = { revision: 1, requestId: randomUUID() };
      await Promise.all([
        delivery.test(actor, c.id, dto),
        delivery.test(actor, c.id, dto),
      ]);
      expect(transport.send).toHaveBeenCalledTimes(1);
      expect(transport.send.mock.calls[0][0]).toBe('+243900000010');
    });
    it('bounds tests globally across campaign ids to five per account/hour', async () => {
      for (let i = 0; i < 5; i++) {
        const c = await draft();
        await resetBudget();
        await delivery.test(actor, c.id, {
          revision: 1,
          requestId: randomUUID(),
        });
      }
      const c = await draft();
      await resetBudget();
      await rejectCode(
        delivery.test(actor, c.id, { revision: 1, requestId: randomUUID() }),
        'SMS_TEST_RATE_LIMITED',
      );
      expect(transport.send).toHaveBeenCalledTimes(5);
    });
    it('does not replay an ambiguous test and does not unlock launch', async () => {
      const c = await draft();
      transport.send.mockRejectedValueOnce(
        new Error('DO NOT LOG phone/password/text'),
      );
      const dto = { revision: 1, requestId: randomUUID() };
      await rejectCode(
        delivery.test(actor, c.id, dto),
        'PROVIDER_NOT_CONFIRMED',
      );
      await rejectCode(
        delivery.test(actor, c.id, dto),
        'PROVIDER_NOT_CONFIRMED',
      );
      expect(transport.send).toHaveBeenCalledTimes(1);
      expect((await campaigns.get(actor, c.id)).test).toBeNull();
    });
    it('multiple workers cannot send the same recipient or exceed the global rate', async () => {
      const c = await launched();
      transport.send.mockClear();
      const second = new SmsDeliveryService(
        repository,
        campaigns,
        config,
        transport as unknown as MobishastraMarketingTransport,
      );
      await Promise.all([delivery.sendOne(), second.sendOne()]);
      expect(transport.send).toHaveBeenCalledTimes(1);
      await resetBudget();
      await second.sendOne();
      expect(transport.send).toHaveBeenCalledTimes(2);
      expect(new Set(transport.send.mock.calls.map((c) => c[0])).size).toBe(2);
      await delivery.recover();
      expect((await campaigns.get(actor, c.id)).status).toBe('completed');
    });
    it('rechecks opt-out and account closure after launch', async () => {
      const c = await launched();
      transport.send.mockClear();
      await optOuts.add(actor, {
        phone: '+243900000001',
        reason: 'demande',
        source: 'support',
      });
      await db.query('UPDATE users SET "isActive"=false WHERE id=$1', [driver]);
      await delivery.sendOne();
      await delivery.sendOne();
      expect(transport.send).not.toHaveBeenCalled();
      expect((await campaigns.get(actor, c.id)).stats.skipped).toBe(2);
    });
    it('cancels remaining recipients during a batch without recalling in-flight SMS', async () => {
      const c = await launched();
      transport.send.mockClear();
      transport.send.mockImplementationOnce(async () => {
        await campaigns.cancel(actor, c.id, c.revision);
        return { accepted: true, code: '' };
      });
      await delivery.sendOne();
      await resetBudget();
      await delivery.sendOne();
      expect(transport.send).toHaveBeenCalledTimes(1);
      expect((await campaigns.get(actor, c.id)).stats).toMatchObject({
        sent: 1,
        skipped: 1,
      });
    });
    it('never reclaims an expired sending lease; uncertain outcomes are terminal', async () => {
      const c = await launched();
      transport.send.mockClear();
      const r = await delivery.claim();
      await db.query(
        `UPDATE sms_campaign_recipients SET "leaseUntil"=now()-interval '1 minute' WHERE id=$1`,
        [r.id],
      );
      await delivery.recover();
      await resetBudget();
      await delivery.sendOne();
      const [row] = await db.query(
        'SELECT status,"errorCode" FROM sms_campaign_recipients WHERE id=$1',
        [r.id],
      );
      expect(row).toEqual({
        status: 'failed',
        errorCode: 'PROVIDER_NOT_CONFIRMED',
      });
      expect(transport.send.mock.calls.map((c) => c[0])).not.toContain(r.phone);
    });
    it.each(['expired', 'recovered', 'paused', 'permission'])(
      'rechecks %s between reservation and HTTP',
      async (state) => {
        await launched();
        transport.send.mockClear();
        const original = delivery.claim.bind(delivery);
        const claim = jest
          .spyOn(delivery, 'claim')
          .mockImplementationOnce(async () => {
            const r = await original();
            if (state === 'paused')
              await db.query(
                `UPDATE sms_runtime SET "pauseReason"='INSUFFICIENT_CREDITS'`,
              );
            else if (state === 'permission')
              await db.query('UPDATE users SET "isActive"=false WHERE id=$1', [
                actor,
              ]);
            else {
              await db.query(
                `UPDATE sms_campaign_recipients SET "leaseUntil"=now()-interval '1 minute' WHERE id=$1`,
                [r.id],
              );
              if (state === 'recovered') await delivery.recover();
            }
            return r;
          });
        try {
          await delivery.sendOne();
          expect(transport.send).not.toHaveBeenCalled();
        } finally {
          claim.mockRestore();
        }
      },
    );
    it('pauses globally on insufficient credits and resumes only after a fresh successful test', async () => {
      const c = await launched();
      transport.send.mockResolvedValueOnce({
        accepted: false,
        code: 'INSUFFICIENT_CREDITS',
      });
      await delivery.sendOne();
      await delivery.recover();
      const paused = await campaigns.get(actor, c.id);
      expect(paused.status).toBe('paused');
      await rejectCode(
        campaigns.resume(actor, c.id, paused.revision),
        'SMS_TEST_REQUIRED',
      );
      await resetBudget();
      await delivery.test(actor, c.id, {
        revision: paused.revision,
        requestId: randomUUID(),
      });
      expect(
        (await campaigns.resume(actor, c.id, paused.revision)).status,
      ).toBe('sending');
    });
    it('enforces daily budget and frequency cap', async () => {
      const c = await launched();
      await db.query('UPDATE sms_runtime SET used=$1', [config.dailyLimit]);
      transport.send.mockClear();
      expect(await delivery.sendOne()).toBe(false);
      expect(transport.send).not.toHaveBeenCalled();
      await resetBudget();
      await delivery.sendOne();
      const result = await campaigns.estimate(actor, {
        audience: standard(),
        message: 'Salut',
      });
      expect(result.excluded.frequencyCap).toBe(1);
    });
    it('public GET does not mutate; POST is idempotent, test code never unsubscribes', async () => {
      const c = await launched();
      const [r] = await db.query(
        'SELECT "optOutCode" code FROM sms_campaign_recipients WHERE "campaignId"=$1 LIMIT 1',
        [c.id],
      );
      const page = await optOuts.publicPage(r.code, false);
      expect(page).not.toMatch(/<script|https:\/\//);
      expect((await optOuts.list(actor, new SmsPageDto())).total).toBe(0);
      await Promise.all([
        optOuts.publicPage(r.code, true),
        optOuts.publicPage(r.code, true),
      ]);
      expect((await optOuts.list(actor, new SmsPageDto())).total).toBe(1);
      const [test] = await db.query('SELECT code FROM sms_test_sends LIMIT 1');
      expect(await optOuts.publicPage(test.code, true)).toContain(
        'Lien de test',
      );
      expect((await optOuts.list(actor, new SmsPageDto())).total).toBe(1);
      expect(await optOuts.publicPage('abcdefgh', false)).toBe(page);
    });
    it('opt-outs survive account deletion and opt-in retains the history', async () => {
      const out = await optOuts.add(actor, {
        phone: '+243900000001',
        reason: 'demande',
        source: 'team',
      });
      await db.query('DELETE FROM users WHERE id=$1', [passenger]);
      expect((await optOuts.list(actor, new SmsPageDto())).total).toBe(1);
      await optOuts.remove(
        actor,
        out.id,
        'La personne demande sa réinscription',
      );
      expect((await optOuts.list(actor, new SmsPageDto())).total).toBe(0);
      expect(
        (
          await db.query('SELECT "removedAt" FROM sms_opt_outs WHERE id=$1', [
            out.id,
          ])
        )[0].removedAt,
      ).not.toBeNull();
    });
    it('enforces server permissions and exposes no raw recipient phone', async () => {
      const c = await tested();
      await rejectCode(
        campaigns.launch(marketer, c.id, {
          revision: 1,
          requestId: randomUUID(),
          scheduledAt: null,
          expectedRecipients: 2,
        }),
        'SMS_FORBIDDEN',
      );
      await rejectCode(
        optOuts.add(marketer, {
          phone: '+243900000001',
          reason: 'test',
          source: 'team',
        }),
        'SMS_FORBIDDEN',
      );
      await rejectCode(campaigns.status(passenger), 'SMS_FORBIDDEN');
      expect((await campaigns.status(marketer)).permissions).toEqual([
        'sms.read',
        'sms.write',
      ]);
      await campaigns.launch(actor, c.id, {
        revision: 1,
        requestId: randomUUID(),
        scheduledAt: null,
        expectedRecipients: 2,
      });
      const page = await campaigns.recipients(actor, c.id, new SmsPageDto());
      expect(page.total).toBe(2);
      expect(JSON.stringify(page)).not.toContain('+243900000001');
    });
    it('disabled module rejects writes and delivery without disabling public opt-out or status', async () => {
      const enabled = jest
        .spyOn(config, 'enabled', 'get')
        .mockReturnValue(false);
      try {
        await rejectCode(draft(), 'SMS_DISABLED');
        expect(await delivery.sendOne()).toBe(false);
        expect(transport.send).not.toHaveBeenCalled();
        expect((await campaigns.status(actor)).enabled).toBe(false);
        expect(await optOuts.publicPage('Unknown1', false)).toContain(
          'SMS promotionnels',
        );
      } finally {
        enabled.mockRestore();
      }
    });
    it('measures one aggregate query on 50,000 synthetic recipients', async () => {
      await db.query(`INSERT INTO users(id,phone,role,"firstName","lastName")
      SELECT gen_random_uuid(),'+24398'||lpad(n::text,7,'0'),'passenger','Jean','Synthetic' FROM generate_series(1,49998) n`);
      await db.query('ANALYZE users');
      const start = performance.now();
      const estimate = await campaigns.estimate(actor, {
        audience: standard(),
        message: 'Bonjour !',
      });
      const elapsed = Math.round(performance.now() - start);
      expect(estimate.recipients).toBe(50000);
      expect(estimate.segments).toBe(50000);
      console.info('SMS aggregate benchmark (synthetic local data)', {
        recipients: estimate.recipients,
        elapsedMs: elapsed,
      });
      expect(elapsed).toBeLessThan(3000);
    });
  },
);
