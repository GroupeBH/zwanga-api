import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { SmsRepository } from './sms.repository';
import { SmsCampaignsService } from './sms.campaigns';
import { SmsMarketingConfig } from './sms.config';
import {
  MobishastraMarketingTransport,
  SmsResult,
} from './mobishastra-marketing.transport';
import { renderSms, smsError, smsLength } from './sms.policy';
import { SmsTestDto } from './sms.dto';

@Injectable()
export class SmsDeliveryService implements OnModuleDestroy {
  private readonly logger = new Logger(SmsDeliveryService.name);
  private stopping = false;
  private running?: Promise<void>;
  constructor(
    readonly repository: SmsRepository,
    readonly campaigns: SmsCampaignsService,
    readonly config: SmsMarketingConfig,
    readonly transport: MobishastraMarketingTransport,
  ) {}
  async budget(
    m: EntityManager,
    segments: number,
    test = false,
  ): Promise<boolean> {
    const [row] = await m.query(`SELECT *,clock_timestamp()>="nextSendAt" due,
      day=(clock_timestamp() AT TIME ZONE 'Africa/Kinshasa')::date "sameDay",
      (clock_timestamp() AT TIME ZONE 'Africa/Kinshasa')::date::text today FROM sms_runtime WHERE id=1 FOR UPDATE`);
    if (!row.due || (!test && row.pauseReason)) return false;
    const used = row.sameDay ? row.used : 0;
    if (used + segments > this.config.dailyLimit) return false;
    await m.query(
      `UPDATE sms_runtime SET day=$1,used=$2,"nextSendAt"=clock_timestamp()+$3::double precision*interval '1 millisecond' WHERE id=1`,
      [row.today, used + segments, Math.ceil(1000 / this.config.rate)],
    );
    return true;
  }
  async test(actor: string, id: string, dto: SmsTestDto) {
    this.campaigns.assertConfigured();
    const claimed = await this.repository.transaction(async (m) => {
      const user = await this.repository.actor(m, actor, 'sms.write');
      const c = await this.repository.lock(m, id);
      const key = `test:${actor}:${dto.requestId}`;
      if (await this.repository.intent(m, key, id, dto)) {
        const [previous] = await m.query(
          'SELECT status,"errorCode" FROM sms_test_sends WHERE "requestKey"=$1',
          [key],
        );
        if (previous?.status === 'failed')
          smsError(
            previous.errorCode,
            'Le SMS de test n’a pas été confirmé. Aucun nouvel essai automatique ne sera effectué.',
            503,
          );
        return null;
      }
      if (c.revision !== dto.revision)
        smsError(
          'SMS_REVISION_CONFLICT',
          'La campagne a changé. Actualisez la page.',
          409,
        );
      if (!['draft', 'paused'].includes(c.status))
        smsError(
          'SMS_INVALID_STATE',
          'Le test est réservé aux brouillons et campagnes en pause.',
          409,
        );
      if (!user.phone || !/^\+[1-9]\d{6,14}$/.test(user.phone))
        smsError(
          'SMS_NO_TEST_PHONE',
          'Votre compte ne possède pas de numéro utilisable.',
        );
      // Never bypass an opt-out, even for an administrator testing on their own phone.
      const [out] = await m.query(
        'SELECT id FROM sms_opt_outs WHERE phone=$1 AND "removedAt" IS NULL',
        [user.phone],
      );
      if (out)
        smsError(
          'OPTED_OUT',
          'Votre numéro est désinscrit des SMS promotionnels.',
        );
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `sms-test:${actor}`,
      ]);
      const [rate] = await m.query(
        'SELECT count(*)::int n FROM sms_test_sends WHERE "actorId"=$1 AND "createdAt">now()-interval \'1 hour\'',
        [actor],
      );
      if (rate.n >= 5)
        smsError(
          'SMS_TEST_RATE_LIMITED',
          'Vous avez atteint cinq tests en une heure.',
          429,
        );
      const [{ code }] = await m.query('SELECT sms_new_code() code');
      const text = renderSms(
        c.message,
        user.firstName,
        this.config.suffix(code),
      );
      if (smsLength(text).segments > 1)
        smsError('SMS_MESSAGE_TOO_LONG', 'Le SMS de test dépasse un segment.');
      if (!(await this.budget(m, smsLength(text).segments, true)))
        smsError(
          'SMS_RATE_LIMITED',
          'Le budget SMS est atteint ou un envoi vient de commencer. Patientez.',
          429,
        );
      const [test] = await m.query(
        `INSERT INTO sms_test_sends("campaignId","actorId",revision,"requestKey",code,status)
        VALUES($1,$2,$3,$4,$5,'sending') RETURNING id`,
        [id, actor, c.revision, key, code],
      );
      await this.repository.audit(m, actor, 'test_started', id, {
        revision: c.revision,
      });
      return { testId: test.id, phone: user.phone, text, revision: c.revision };
    });
    if (claimed) {
      const allowed = await this.repository.transaction(async (m) => {
        const c = await this.repository.lock(m, id);
        const [t] = await m.query(
          `SELECT id FROM sms_test_sends WHERE id=$1 AND status='sending'
          AND "createdAt">clock_timestamp()-interval '105 seconds' FOR UPDATE`,
          [claimed.testId],
        );
        if (
          !t ||
          c.revision !== claimed.revision ||
          !['draft', 'paused'].includes(c.status) ||
          !this.config.enabled
        )
          return false;
        const user = await this.repository.actor(m, actor, 'sms.write');
        if (user.phone !== claimed.phone) return false;
        const [out] = await m.query(
          'SELECT id FROM sms_opt_outs WHERE phone=$1 AND "removedAt" IS NULL',
          [claimed.phone],
        );
        return !out;
      });
      // No transaction or connection is retained during the provider call.
      const result: SmsResult = allowed
        ? await this.transport
            .send(claimed.phone, claimed.text)
            .catch((): SmsResult => ({
              accepted: false,
              code: 'PROVIDER_NOT_CONFIRMED',
            }))
        : { accepted: false, code: 'TEST_NO_LONGER_AUTHORIZED' };
      await this.repository.transaction(async (m) => {
        const c = await this.repository.lock(m, id);
        const rows = await m.query(
          `UPDATE sms_test_sends SET status=$2,"errorCode"=$3 WHERE id=$1 AND status='sending' RETURNING id`,
          [
            claimed.testId,
            result.accepted ? 'sent' : 'failed',
            result.accepted ? null : result.code,
          ],
        );
        if (rows[0] && result.accepted && c.revision === claimed.revision)
          await m.query(
            'UPDATE sms_campaigns SET "testSentAt"=now(),"testRevision"=$2 WHERE id=$1',
            [id, claimed.revision],
          );
        await this.repository.audit(
          m,
          actor,
          result.accepted ? 'test_sent' : 'test_failed',
          id,
          {
            revision: claimed.revision,
            ...(!result.accepted ? { code: result.code } : {}),
          },
        );
      });
      if (!result.accepted)
        smsError(
          result.code,
          'Le SMS de test n’a pas été confirmé. Aucun nouvel essai automatique ne sera effectué.',
          503,
        );
    }
    return this.campaigns.get(actor, id);
  }
  async startScheduled() {
    await this.repository.transaction(async (m) => {
      const [c] =
        await m.query(`SELECT * FROM sms_campaigns WHERE status='scheduled' AND "scheduledAt"<=now()
        ORDER BY "scheduledAt",id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!c) return;
      try {
        await this.repository.actor(m, c.launchedById, 'sms.send');
      } catch {
        await m.query(
          `UPDATE sms_campaigns SET status='paused',"pauseReason"='PERMISSION_REVOKED',revision=revision+1,"updatedAt"=now() WHERE id=$1`,
          [c.id],
        );
        return;
      }
      const estimate = await this.campaigns.audience.estimate(
        m,
        c.audience,
        c.message,
      );
      if (estimate.recipients > this.config.maxRecipients) {
        await m.query(
          `UPDATE sms_campaigns SET status='paused',"pauseReason"='SMS_AUDIENCE_TOO_LARGE',revision=revision+1,"updatedAt"=now() WHERE id=$1`,
          [c.id],
        );
        return;
      }
      await this.campaigns.audience.freeze(m, c.id, c.audience, c.message);
      await m.query(
        `UPDATE sms_campaigns SET status='sending',"startedAt"=now(),estimate=$2,revision=revision+1,"updatedAt"=now() WHERE id=$1`,
        [c.id, JSON.stringify(estimate)],
      );
      await this.repository.audit(m, null, 'scheduled_started', c.id, {
        expected: c.expectedRecipients,
        actual: estimate.recipients,
      });
    }, 'REPEATABLE READ');
  }
  async claim() {
    return this.repository.transaction(async (m) => {
      const [c] =
        await m.query(`SELECT id,"launchedById" FROM sms_campaigns c WHERE status='sending'
        AND EXISTS(SELECT 1 FROM sms_campaign_recipients r WHERE r."campaignId"=c.id AND r.status='queued')
        ORDER BY "startedAt",id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!c) return null;
      try {
        await this.repository.actor(m, c.launchedById, 'sms.send');
      } catch {
        await m.query(
          `UPDATE sms_campaigns SET status='paused',"pauseReason"='PERMISSION_REVOKED',revision=revision+1,"updatedAt"=now() WHERE id=$1`,
          [c.id],
        );
        return null;
      }
      const [r] = await m.query(
        `SELECT * FROM sms_campaign_recipients WHERE "campaignId"=$1 AND status='queued'
        ORDER BY "createdAt",id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [c.id],
      );
      if (!r) return null;
      const reason = await this.exclusion(m, r);
      if (reason) {
        await m.query(
          `UPDATE sms_campaign_recipients SET status='skipped',"errorCode"=$2 WHERE id=$1`,
          [r.id, reason],
        );
        return { skipped: true };
      }
      // Serialize frequency checks across campaigns before taking the global budget.
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `sms-phone:${r.phone}`,
      ]);
      const [recent] = await m.query(
        `SELECT id FROM sms_campaign_recipients WHERE phone=$1 AND id<>$2
        AND (status='sending' OR (status IN ('sent','delivered') AND "sentAt">now()-$3::int*interval '1 day')) LIMIT 1`,
        [r.phone, r.id, this.config.frequencyDays],
      );
      if (recent) {
        await m.query(
          `UPDATE sms_campaign_recipients SET status='skipped',"errorCode"='FREQUENCY_CAP' WHERE id=$1`,
          [r.id],
        );
        return { skipped: true };
      }
      if (!(await this.budget(m, r.segments))) return null;
      const lease = randomUUID();
      await m.query(
        `UPDATE sms_campaign_recipients SET status='sending',"leaseId"=$2,"leaseUntil"=now()+interval '2 minutes' WHERE id=$1`,
        [r.id, lease],
      );
      return { ...r, leaseId: lease, skipped: false };
    });
  }
  private async exclusion(m: EntityManager, r: any): Promise<string | null> {
    const [out] = await m.query(
      'SELECT id FROM sms_opt_outs WHERE phone=$1 AND "removedAt" IS NULL',
      [r.phone],
    );
    if (out) return 'OPTED_OUT';
    const [user] = await m.query(
      `SELECT id FROM users WHERE id=$1 AND zwanga_canonical_phone(phone)=$2
      AND "isActive" AND "deletedAt" IS NULL AND status NOT IN ('inactive','suspended') AND role IN ('driver','passenger')`,
      [r.userId, r.phone],
    );
    return user ? null : 'ACCOUNT_CLOSED';
  }
  async sendOne(): Promise<boolean> {
    if (
      this.stopping ||
      !this.config.enabled ||
      !this.transport.configured() ||
      !this.config.open()
    )
      return false;
    const r = await this.claim();
    if (!r) return false;
    if (r.skipped) return true;
    // Final check after claim and immediately before network. A submission already
    // in flight cannot be recalled; cancellation prevents subsequent submissions.
    const allowed = await this.repository.transaction(async (m) => {
      const c = await this.repository.lock(m, r.campaignId);
      const [owned] = await m.query(
        `SELECT id FROM sms_campaign_recipients WHERE id=$1 AND "leaseId"=$2
        AND status='sending' AND "leaseUntil">clock_timestamp()+interval '15 seconds' FOR UPDATE`,
        [r.id, r.leaseId],
      );
      if (!owned) return false;
      const [runtime] = await m.query(
        'SELECT "pauseReason" FROM sms_runtime WHERE id=1',
      );
      let reason =
        c.status !== 'sending' || runtime.pauseReason
          ? 'CAMPAIGN_STOPPED'
          : await this.exclusion(m, r);
      if (!reason) {
        try {
          await this.repository.actor(m, c.launchedById!, 'sms.send');
        } catch {
          reason = 'PERMISSION_REVOKED';
        }
      }
      if (
        reason ||
        !this.config.enabled ||
        !this.config.open() ||
        this.stopping
      ) {
        await m.query(
          `UPDATE sms_campaign_recipients SET status='skipped',"errorCode"=$3,"leaseUntil"=NULL
          WHERE id=$1 AND "leaseId"=$2 AND status='sending'`,
          [r.id, r.leaseId, reason ?? 'SENDING_STOPPED'],
        );
        return false;
      }
      return true;
    });
    if (!allowed) return true;
    const result = await this.transport
      .send(r.phone, r.renderedText)
      .catch((): SmsResult => ({
        accepted: false,
        code: 'PROVIDER_NOT_CONFIRMED',
      }));
    await this.repository.transaction(async (m) => {
      await this.repository.lock(m, r.campaignId);
      const changed = await m.query(
        `UPDATE sms_campaign_recipients SET status=$3,"errorCode"=$4,
        "sentAt"=CASE WHEN $3='sent' THEN now() ELSE NULL END,"leaseUntil"=NULL WHERE id=$1 AND "leaseId"=$2 AND status='sending' RETURNING id`,
        [
          r.id,
          r.leaseId,
          result.accepted ? 'sent' : 'failed',
          result.accepted ? null : result.code,
        ],
      );
      if (!changed.length) return;
      const [state] = await m.query(
        `UPDATE sms_runtime SET failures=CASE WHEN $1 THEN 0 ELSE failures+1 END WHERE id=1 RETURNING failures`,
        [result.accepted],
      );
      if (
        !result.accepted &&
        (result.code === 'INSUFFICIENT_CREDITS' ||
          state.failures >= this.config.pauseAfter)
      ) {
        await m.query('UPDATE sms_runtime SET "pauseReason"=$1 WHERE id=1', [
          result.code,
        ]);
        // Other campaigns consult the global circuit before claims. Do not take
        // their row locks here: a different sender may already hold one of them.
        await m.query(
          `UPDATE sms_campaigns SET status='paused',"pauseReason"=$2,revision=revision+1,"updatedAt"=now() WHERE id=$1 AND status='sending'`,
          [r.campaignId, result.code],
        );
      }
    });
    return true;
  }
  async recover() {
    // Test recovery never holds a recipient/test lock while acquiring a campaign
    // lock. Every campaign path uses campaign -> recipient -> global budget.
    await this.repository.transaction(async (m) => {
      await m.query(
        `UPDATE sms_test_sends SET status='failed',"errorCode"='PROVIDER_NOT_CONFIRMED' WHERE status='sending' AND "createdAt"<now()-interval '2 minutes'`,
      );
    });
    await this.repository.transaction(async (m) => {
      const rows = await m.query(`SELECT id FROM sms_campaigns c WHERE
        EXISTS(SELECT 1 FROM sms_campaign_recipients r WHERE r."campaignId"=c.id AND r.status='sending' AND r."leaseUntil"<now())
        OR (status='sending' AND ((SELECT "pauseReason" FROM sms_runtime WHERE id=1) IS NOT NULL OR
          NOT EXISTS(SELECT 1 FROM sms_campaign_recipients r WHERE r."campaignId"=c.id AND r.status IN ('queued','sending'))))
        ORDER BY c.id LIMIT 25 FOR UPDATE SKIP LOCKED`);
      for (const { id } of rows) {
        await m.query(
          `UPDATE sms_campaign_recipients SET status='failed',"errorCode"='PROVIDER_NOT_CONFIRMED',"leaseUntil"=NULL
          WHERE "campaignId"=$1 AND status='sending' AND "leaseUntil"<now()`,
          [id],
        );
        await m.query(
          `UPDATE sms_campaigns c SET status='paused',"pauseReason"=s."pauseReason",revision=revision+1,"updatedAt"=now()
          FROM sms_runtime s WHERE c.id=$1 AND s.id=1 AND s."pauseReason" IS NOT NULL AND c.status='sending'`,
          [id],
        );
        await m.query(
          `UPDATE sms_campaigns c SET status='completed',"completedAt"=now(),revision=revision+1,"updatedAt"=now()
          WHERE c.id=$1 AND status='sending' AND NOT EXISTS(SELECT 1 FROM sms_campaign_recipients r WHERE r."campaignId"=c.id AND r.status IN ('queued','sending'))`,
          [id],
        );
      }
    });
  }
  @Cron('*/10 * * * * *', { waitForCompletion: true })
  tick(): Promise<void> {
    if (
      this.running ||
      this.stopping ||
      !this.config.enabled ||
      !this.transport.configured()
    )
      return this.running ?? Promise.resolve();
    this.running = this.run()
      .catch(() => {
        this.logger.warn('SMS_MARKETING_WORKER_RETRY_NEXT_TICK');
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async run() {
    await this.recover();
    if (!this.config.open()) return;
    await this.startScheduled();
    for (let i = 0; i < this.config.rate * 10 && !this.stopping; i++) {
      if (!(await this.sendOne())) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.ceil(1000 / this.config.rate)),
      );
    }
    await this.recover();
  }
  async onModuleDestroy() {
    this.stopping = true;
    await this.running;
  }
}
