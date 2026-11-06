import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { MobileConfig } from './mobile.config';
import { mobileTick } from './mobile-campaign-delivery';
import { mobileAudit } from './mobile-audit';
import { MobilePoliciesService } from './mobile-policies.service';
import { MobilePageDto } from './mobile.dto';

@Injectable()
export class MobileMaintenanceService {
  private readonly logger = new Logger(MobileMaintenanceService.name);
  constructor(
    private readonly db: DataSource,
    private readonly config: MobileConfig,
    private readonly policies: MobilePoliciesService,
  ) {}
  @Cron('20 * * * * *', { waitForCompletion: true })
  async monitor() {
    if (!this.config.enabled) return;
    try {
      await this.db.transaction(async (m) => {
        await m.query(`SET LOCAL statement_timeout='5s'`);
        if (!(await mobileTick(m, 'monitor', 60))) return;
        const rules = await m.query(
          `SELECT * FROM store_alert_rules WHERE enabled AND type LIKE 'mobile_%' ORDER BY id LIMIT 100`,
        );
        for (const rule of rules) {
          const platform =
            rule.platform === 'google'
              ? 'android'
              : rule.platform === 'apple'
                ? 'ios'
                : null;
          let value = 0,
            available = true;
          if (rule.type === 'mobile_push_failure_percent') {
            const [r] = await m.query(
              `SELECT count(*)::int AS total,count(*) FILTER (WHERE n.status='failed')::int AS failed
              FROM notifications n JOIN mobile_campaign_deliveries d ON d."notificationId"=n.id JOIN app_update_installations c ON c.id=d."installationId"
              WHERE n.status IN ('sent','failed') AND n."updatedAt">now()-make_interval(mins=>$1) AND ($2::text IS NULL OR c.platform=$2)`,
              [rule.windowMinutes, platform],
            );
            available = r.total >= 10;
            value = r.total ? (100 * r.failed) / r.total : 0;
          } else if (rule.type === 'mobile_registration_drop_percent') {
            const [r] = await m.query(
              `SELECT count(*) FILTER (WHERE "createdAt">now()-make_interval(mins=>$1))::int AS current,
              count(*) FILTER (WHERE "createdAt"<=now()-make_interval(mins=>$1))::int AS previous
              FROM users WHERE role IN ('driver','passenger') AND "createdAt">now()-make_interval(mins=>2*$1)`,
              [rule.windowMinutes],
            );
            available = r.previous >= 10;
            value = r.previous
              ? (100 * (r.previous - r.current)) / r.previous
              : 0;
          } else if (rule.type === 'mobile_required_policy_conflict') {
            const policies = await m.query(
              `SELECT p.*,r.available,r.version,r.build FROM mobile_update_policies p JOIN app_store_releases r ON r.id=p."releaseId"
              WHERE p.active AND p.mode='REQUIRED' AND p."effectiveAt"<=now() AND (p."expiresAt" IS NULL OR p."expiresAt">now())
              AND ($1::text IS NULL OR p.platform=$1) LIMIT 100`,
              [platform],
            );
            for (const p of policies)
              if (
                !p.available ||
                !p.availabilityConfirmed ||
                (await this.policies.distributionConflict(m, p))
              )
                value++;
          } else continue;
          const [state] = await m.query(
            `INSERT INTO mobile_alert_state ("ruleId","breachedAt") VALUES ($1,CASE WHEN $2 THEN now() ELSE NULL END)
            ON CONFLICT ("ruleId") DO UPDATE SET "breachedAt"=CASE WHEN $2 THEN COALESCE(mobile_alert_state."breachedAt",now()) ELSE NULL END,
            "evaluatedAt"=now() RETURNING *`,
            [rule.id, available && value > Number(rule.threshold ?? 0)],
          );
          if (
            !state.breachedAt ||
            Date.now() - +new Date(state.breachedAt) <
              rule.confirmationMinutes * 60000 ||
            (state.lastEventAt &&
              Date.now() - +new Date(state.lastEventAt) <
                rule.windowMinutes * 60000)
          )
            continue;
          const eventKey = `mobile:${rule.id}:${new Date(state.breachedAt).toISOString()}`;
          await m.query(
            `INSERT INTO store_alert_events ("eventKey","ruleId",platform,code,severity,message,recipients,"emailState")
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ("eventKey") DO NOTHING`,
            [
              eventKey,
              rule.id,
              rule.platform ?? 'mobile',
              rule.type,
              rule.severity,
              `${rule.name} : ${value.toFixed(2)}, seuil ${rule.threshold ?? 0}; fenêtre ${rule.windowMinutes} min, confirmation ${rule.confirmationMinutes} min.`,
              JSON.stringify(rule.recipients),
              rule.email ? 'pending' : 'not_requested',
            ],
          );
          await m.query(
            `UPDATE mobile_alert_state SET "lastEventAt"=now() WHERE "ruleId"=$1`,
            [rule.id],
          );
        }
      });
    } catch {
      this.logger.warn('Mobile monitoring deferred.');
    }
  }
  async resolve(actor: string, id: string, resolution: string) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      const [event] = await m.query(
        `SELECT * FROM store_alert_events WHERE id=$1 FOR UPDATE`,
        [id],
      );
      if (!event) throw new NotFoundException();
      if (!event.resolvedAt) {
        await m.query(
          `UPDATE store_alert_events SET "resolvedAt"=now(),"resolvedBy"=$2,resolution=$3 WHERE id=$1`,
          [id, actor, resolution],
        );
        await mobileAudit(m, actor, 'alert.resolve', id, { resolution });
      }
      return { resolved: true };
    });
  }
  async events(q: MobilePageDto) {
    this.config.assertEnabled();
    const items = await this.db.query(
      `SELECT * FROM store_alert_events ORDER BY "createdAt" DESC,id LIMIT $1 OFFSET $2`,
      [q.limit, (q.page - 1) * q.limit],
    );
    return {
      items,
      page: q.page,
      limit: q.limit,
      delivery: 'existing_admin_inbox_and_optional_store_smtp',
    };
  }
  @Cron('0 40 3 * * *', { timeZone: 'UTC', waitForCompletion: true })
  async retain() {
    if (!this.config.enabled) return;
    try {
      await this.db.transaction(async (m) => {
        await m.query(`SET LOCAL statement_timeout='5s'`);
        if (!(await mobileTick(m, 'retention', 3600))) return;
        // Bound every delete; never touch accounts, financial or ride history.
        const stale = await m.query(
          `SELECT id FROM app_update_installations WHERE "updatedAt"<now()-make_interval(days=>$1)
          ORDER BY "updatedAt" LIMIT 200 FOR UPDATE SKIP LOCKED`,
          [this.config.retentionDays],
        );
        const ids = stale.map((r) => r.id);
        if (ids.length) {
          await m.query(
            `UPDATE notifications SET "fcmToken"='',"isActive"=false WHERE id IN
            (SELECT "notificationId" FROM mobile_campaign_deliveries WHERE "installationId"=ANY($1::uuid[]))`,
            [ids],
          );
          await m.query(
            `DELETE FROM app_update_installations WHERE id=ANY($1::uuid[])`,
            [ids],
          );
        }
        await m.query(
          `DELETE FROM mobile_installation_days WHERE ("installationId",day) IN
          (SELECT "installationId",day FROM mobile_installation_days WHERE day<current_date-$1::int LIMIT 2000)`,
          [this.config.retentionDays],
        );
        await m.query(`UPDATE notifications SET "fcmToken"='' WHERE id IN (SELECT id FROM notifications WHERE data->>'type'='mobile_campaign'
          AND "fcmToken"<>'' AND "updatedAt"<now()-interval '7 days' AND status IN ('sent','failed') LIMIT 500)`);
      });
    } catch {
      this.logger.warn('Mobile data retention deferred.');
    }
  }
}
