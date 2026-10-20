import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { createTransport } from 'nodemailer';
import { StoreConfig } from './store.config';
import { StoreRepository } from './store.repository';
import { StoreAccess } from './store.permissions';
import {
  StoreAlertEvent,
  StoreAlertRule,
  StoreAuditLog,
} from './store-operations.entities';
import { StorePageDto } from './store.dto';
import { STORE_PLATFORMS, day } from './store.types';
import { METRIC_CATALOG } from './store.reports';
import { storeAudit } from './store-operations.service';

export function metricAlert(
  type: string,
  threshold: number,
  current: number,
  previous: number | null,
) {
  return type === 'metric_above'
    ? current > threshold
    : previous !== null &&
        previous > 0 &&
        ((previous - current) / previous) * 100 >= threshold;
}
export function storeMailConfigured(config: StoreConfig) {
  return (
    config.value('STORE_SMTP_ENABLED') === 'true' &&
    [
      'STORE_SMTP_HOST',
      'STORE_SMTP_FROM',
      'STORE_SMTP_USER',
      'STORE_SMTP_PASSWORD',
    ].every((k) => !!config.value(k))
  );
}
@Injectable()
export class StoreAlertsService {
  private readonly logger = new Logger(StoreAlertsService.name);
  constructor(
    private readonly config: StoreConfig,
    private readonly repository: StoreRepository,
    private readonly access: StoreAccess,
  ) {}
  private get db() {
    return this.repository.db;
  }
  @Cron('0 */5 * * * *', { waitForCompletion: true })
  async evaluate() {
    if (!this.config.enabled) return;
    try {
      const rules = await this.db
        .getRepository(StoreAlertRule)
        .find({ where: { enabled: true }, take: 100 });
      for (const rule of rules)
        for (const platform of rule.platform
          ? [rule.platform]
          : STORE_PLATFORMS) {
          try {
            const appId = this.config.appId(platform);
            if (!appId) continue;
            let signals: { key: string; message: string }[] = [];
            if (
              rule.type === 'sync_failed' ||
              rule.type === 'data_unavailable'
            ) {
              const rows = await this.db.query(
                `SELECT id,"errorCode" FROM store_sync_jobs WHERE platform=$1 AND "appId"=$2
              AND state=ANY($3::text[]) AND "createdAt">=now()-interval '7 days' ORDER BY "createdAt" DESC LIMIT 100`,
                [
                  platform,
                  appId,
                  rule.type === 'sync_failed'
                    ? ['failed', 'unknown']
                    : ['unavailable'],
                ],
              );
              signals = rows.map((r) => ({
                key: r.id,
                message: `Synchronisation ${r.id} : ${r.errorCode ?? rule.type}.`,
              }));
            } else if (rule.type === 'negative_review') {
              const rows = await this.db.query(
                `SELECT id,content->>'rating' AS rating FROM store_records WHERE platform=$1 AND "appId"=$2 AND kind='review'
              AND (content->>'rating')::numeric <= $3 AND "syncedAt">=now()-interval '7 days' ORDER BY "syncedAt" DESC LIMIT 100`,
                [platform, appId, rule.threshold],
              );
              signals = rows.map((r) => ({
                key: `${r.id}:${r.rating}`,
                message: `Avis ${r.id} : ${r.rating}/5. Une intervention est demandée.`,
              }));
            } else if (rule.type === 'unanswered_reviews') {
              const [r] = await this.db.query(
                `SELECT count(*)::int AS n FROM store_records WHERE platform=$1 AND "appId"=$2 AND kind='review' AND NULLIF(content->>'response','') IS NULL`,
                [platform, appId],
              );
              if (r.n > Number(rule.threshold))
                signals = [
                  {
                    key: day(),
                    message: `${r.n} avis importés sans réponse (seuil ${rule.threshold}).`,
                  },
                ];
            } else if (rule.type === 'version_changed') {
              const rows = await this.db
                .getRepository(StoreAuditLog)
                .createQueryBuilder('a')
                .where(
                  "a.action='version.observed' AND a.details->>'platform'=:platform AND a.details->>'appId'=:appId",
                  { platform, appId },
                )
                .andWhere("a.createdAt>=now()-interval '7 days'")
                .orderBy('a.createdAt', 'DESC')
                .take(100)
                .getMany();
              signals = rows.map((r) => ({
                key: r.id,
                message: `Version/build observé ou modifié : ${String(r.details.externalId)}.`,
              }));
            } else if (
              rule.metric &&
              METRIC_CATALOG.some((m) => m.id === rule.metric)
            ) {
              const rows = await this.db.query(
                `SELECT date::text,SUM(value)::text AS value FROM store_metrics WHERE platform=$1 AND "appId"=$2 AND metric=$3
              AND (platform<>'google' OR dataset NOT LIKE 'installs%' OR dataset='installs')
              AND date>=current_date-interval '14 days' AND date<current_date GROUP BY date ORDER BY date DESC LIMIT 2`,
                [platform, appId, rule.metric],
              );
              // Compare consecutive provider days only; missing/private data is never zero.
              if (
                rows.length &&
                (rule.type === 'metric_above' ||
                  (rows[1] &&
                    Date.parse(rows[0].date) - Date.parse(rows[1].date) ===
                      86400000)) &&
                metricAlert(
                  rule.type,
                  Number(rule.threshold),
                  Number(rows[0].value),
                  rows[1] ? Number(rows[1].value) : null,
                )
              )
                signals = [
                  {
                    key: rows[0].date,
                    message: `${rule.metric} = ${rows[0].value} le ${rows[0].date}; règle ${rule.name}.`,
                  },
                ];
            }
            for (const signal of signals) {
              const eventKey = createHash('sha256')
                .update(
                  `${rule.id}:${rule.updatedAt.toISOString()}:${platform}:${appId}:${signal.key}`,
                )
                .digest('hex');
              await this.db
                .getRepository(StoreAlertEvent)
                .createQueryBuilder()
                .insert()
                .values({
                  eventKey,
                  ruleId: rule.id,
                  platform,
                  code: rule.type,
                  severity: rule.severity,
                  message: signal.message,
                  recipients: rule.recipients,
                  emailState: rule.email ? 'pending' : 'not_requested',
                })
                .orIgnore()
                .execute();
            }
          } catch {
            this.logger.warn(
              `Store alert evaluation failed: rule=${rule.id}, platform=${platform}`,
            );
          }
        }
    } catch {
      this.logger.warn('Store alert evaluation unavailable');
    }
  }
  async events(query: StorePageDto) {
    this.config.assertEnabled();
    const [items, total] = await this.db
      .getRepository(StoreAlertEvent)
      .findAndCount({
        where: query.platform ? { platform: query.platform } : {},
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      });
    return {
      items,
      total,
      page: query.page,
      limit: query.limit,
      emailConfigured: storeMailConfigured(this.config),
    };
  }
  async acknowledge(actor: string, id: string) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      const row = await m
        .getRepository(StoreAlertEvent)
        .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!row) throw new NotFoundException();
      if (!row.acknowledgedAt) {
        row.acknowledgedAt = new Date();
        row.acknowledgedBy = actor;
        await m.getRepository(StoreAlertEvent).save(row);
        await storeAudit(m, actor, 'alert.acknowledge', id);
      }
      return row;
    });
  }
  @Cron('15 * * * * *', { waitForCompletion: true })
  async deliverEmails() {
    if (!this.config.enabled || !storeMailConfigured(this.config)) return;
    try {
      // Ambiguous SMTP delivery is not automatically replayed (avoids repeated emails).
      await this.db.query(
        `UPDATE store_alert_events SET "emailState"='unknown' WHERE "emailState"='sending' AND "emailClaimedAt"<now()-interval '5 minutes'`,
      );
      const events = await this.db.transaction(async (m) => {
        const rows = await m
          .getRepository(StoreAlertEvent)
          .createQueryBuilder('e')
          .where("e.emailState='pending'")
          .orderBy('e.createdAt', 'ASC')
          .take(3)
          .setLock('pessimistic_write')
          .setOnLocked('skip_locked')
          .getMany();
        for (const row of rows) {
          row.emailState = 'sending';
          row.emailClaimedAt = new Date();
          await m.getRepository(StoreAlertEvent).save(row);
        }
        return rows;
      });
      for (const event of events) {
        let state = 'failed';
        let attempted = false;
        try {
          const users = await this.db.query(
            `SELECT id,role,email FROM users WHERE id=ANY($1::uuid[]) AND "isActive" AND role IN ('admin','super_admin','marketer')`,
            [event.recipients],
          );
          const emails: string[] = [];
          for (const user of users)
            if (
              /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(user.email ?? '') &&
              (await this.access.permissions(user.id, user.role)).includes(
                'store.alerts.read',
              )
            )
              emails.push(user.email);
          if (!emails.length) state = 'no_eligible_recipient';
          else {
            const port = Number(this.config.value('STORE_SMTP_PORT') || '465');
            if (![465, 587].includes(port))
              throw new Error('Invalid SMTP port');
            const transport = createTransport({
              host: this.config.value('STORE_SMTP_HOST'),
              port,
              secure: port === 465,
              requireTLS: true,
              auth: {
                user: this.config.value('STORE_SMTP_USER'),
                pass: this.config.value('STORE_SMTP_PASSWORD'),
              },
              connectionTimeout: 10000,
              greetingTimeout: 10000,
              socketTimeout: 15000,
              logger: false,
              debug: false,
              disableFileAccess: true,
              disableUrlAccess: true,
              tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
            });
            try {
              attempted = true;
              await transport.sendMail({
                from: this.config.value('STORE_SMTP_FROM'),
                bcc: [...new Set(emails)],
                messageId: `<store-${event.id}@zwanga-app.com>`,
                subject: `Zwanga Stores : ${event.platform} / ${event.code}`,
                text: `${event.message}\nConsultez Stores > Alertes dans Zwanga Admin. Référence : ${event.id}.`,
              });
              state = 'sent';
            } finally {
              transport.close();
            }
          }
        } catch {
          state = attempted ? 'unknown' : 'failed';
        }
        await this.db
          .getRepository(StoreAlertEvent)
          .update(
            { id: event.id, emailState: 'sending' },
            { emailState: state },
          );
      }
    } catch {
      this.logger.warn('Store alert email delivery unavailable');
    }
  }
  @Cron('0 20 3 * * *', { timeZone: 'UTC', waitForCompletion: true })
  async retain() {
    if (!this.config.enabled) return;
    const configured = Number(
      this.config.value('STORE_RETENTION_MONTHS') || '24',
    );
    const months =
      Number.isInteger(configured) && configured >= 1 && configured <= 120
        ? configured
        : 24;
    try {
      // Bounded deletion of module history only. Active/unknown jobs and referenced records are retained.
      await this.db.transaction(async (m) => {
        await m.query("SET LOCAL statement_timeout='5s'");
        await m.query(
          `DELETE FROM store_metrics WHERE id IN (SELECT id FROM store_metrics WHERE date<current_date-make_interval(months=>$1) LIMIT 5000)`,
          [months],
        );
        await m.query(
          `DELETE FROM store_alert_events WHERE id IN (SELECT id FROM store_alert_events WHERE "createdAt"<now()-make_interval(months=>$1) AND "emailState" NOT IN ('pending','sending','unknown') LIMIT 1000)`,
          [months],
        );
        await m.query(
          `DELETE FROM store_audit_logs WHERE id IN (SELECT id FROM store_audit_logs WHERE "createdAt"<now()-make_interval(months=>$1) LIMIT 1000)`,
          [months],
        );
        await m.query(
          `DELETE FROM store_sync_jobs j WHERE j.id IN (SELECT s.id FROM store_sync_jobs s WHERE s."createdAt"<now()-make_interval(months=>$1) AND s.state IN ('succeeded','failed','unavailable') AND NOT EXISTS(SELECT 1 FROM store_review_workflows w WHERE w."publishedJobId"=s.id) LIMIT 1000)`,
          [months],
        );
        await m.query(
          `DELETE FROM store_records WHERE id IN (SELECT r.id FROM store_records r WHERE r."syncedAt"<now()-make_interval(months=>$1)
          AND NOT EXISTS(SELECT 1 FROM store_review_workflows w WHERE w."recordId"=r.id AND w.status<>'closed')
          AND NOT EXISTS(SELECT 1 FROM store_release_incidents i WHERE i."recordId"=r.id)
          AND NOT EXISTS(SELECT 1 FROM store_sync_jobs j WHERE j.input->>'recordId'=r.id::text AND j.state IN ('pending','running','unknown')) LIMIT 1000)`,
          [months],
        );
      });
    } catch {
      this.logger.warn('Store retention postponed');
    }
  }
}
