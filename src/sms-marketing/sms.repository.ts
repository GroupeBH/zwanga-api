import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { createHash } from 'node:crypto';
import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { SmsMarketingConfig } from './sms.config';
import { SmsAudienceDto, SmsPageDto } from './sms.dto';
import { maskPhone, permissions, SmsPermission, smsError } from './sms.policy';

export interface SmsCampaignRow {
  id: string;
  revision: number;
  name: string;
  message: string;
  audience: SmsAudienceDto;
  status: string;
  testRevision: number | null;
  testSentAt: Date | null;
  createdById: string | null;
  launchedById: string | null;
  expectedRecipients: number;
  scheduledAt: Date | null;
  [key: string]: any;
}
export const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
@Injectable()
export class SmsRepository {
  constructor(
    readonly db: DataSource,
    readonly config: SmsMarketingConfig,
  ) {}
  // All SQL is parameterized. Suppress DB spans containing rendered messages;
  // local catches translate failures, so QueryFailedError parameters never escape.
  async transaction<T>(
    work: (m: EntityManager) => Promise<T>,
    isolation: 'READ COMMITTED' | 'REPEATABLE READ' = 'READ COMMITTED',
  ): Promise<T> {
    try {
      return await context.with(suppressTracing(context.active()), () =>
        this.db.transaction(isolation, async (m) => {
          await m.query(
            "SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s'; SET LOCAL TIME ZONE 'UTC'",
          );
          return work(m);
        }),
      );
    } catch (error) {
      if (error && typeof (error as any).getStatus === 'function') throw error;
      smsError(
        'SMS_TEMPORARILY_UNAVAILABLE',
        'Le service SMS est temporairement indisponible. Réessayez en conservant la même demande.',
        503,
      );
    }
  }
  async actor(m: EntityManager, id: string, permission: SmsPermission) {
    const [user] = await m.query(
      `SELECT id,role,phone,"firstName","lastName" FROM users WHERE id=$1
      AND "isActive" AND "deletedAt" IS NULL AND status NOT IN ('inactive','suspended')`,
      [id],
    );
    if (!user || !permissions(user.role).includes(permission))
      smsError(
        'SMS_FORBIDDEN',
        'Vous ne disposez pas de cette autorisation.',
        403,
      );
    return user;
  }
  async lock(
    m: EntityManager,
    id: string,
    revision?: number,
  ): Promise<SmsCampaignRow> {
    const [c] = await m.query(
      'SELECT * FROM sms_campaigns WHERE id=$1 FOR UPDATE',
      [id],
    );
    if (!c) smsError('SMS_NOT_FOUND', 'Campagne introuvable.', 404);
    if (revision !== undefined && c.revision !== revision)
      smsError(
        'SMS_REVISION_CONFLICT',
        'La campagne a changé. Actualisez la page.',
        409,
      );
    return c;
  }
  async audit(
    m: EntityManager,
    actor: string | null,
    action: string,
    campaign: string | null,
    detail: Record<string, unknown> = {},
  ) {
    await m.query(
      'INSERT INTO sms_audit("actorId",action,"campaignId",detail) VALUES($1,$2,$3,$4)',
      [actor, action, campaign, JSON.stringify(detail)],
    );
  }
  async intent(
    m: EntityManager,
    key: string,
    id: string,
    value: unknown,
  ): Promise<boolean> {
    const hash = fingerprint(value);
    const rows = await m.query(
      'INSERT INTO sms_intents(key,"campaignId",fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key',
      [key, id, hash],
    );
    if (rows.length) return false;
    const [old] = await m.query(
      'SELECT "campaignId",fingerprint FROM sms_intents WHERE key=$1',
      [key],
    );
    if (old.campaignId !== id || old.fingerprint !== hash)
      smsError(
        'SMS_IDEMPOTENCY_CONFLICT',
        'Cette demande a déjà servi à une autre opération.',
        409,
      );
    return true;
  }
  async view(m: EntityManager, id: string) {
    const [c] = await this.views(m, [id]);
    if (!c) smsError('SMS_NOT_FOUND', 'Campagne introuvable.', 404);
    return c;
  }
  async views(m: EntityManager, ids: string[]) {
    if (!ids.length) return [];
    const rows = await m.query(
      `SELECT c.*,CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id',a.id,'name',concat_ws(' ',a."firstName",a."lastName")) END "createdBy",
      CASE WHEN l.id IS NULL THEN NULL ELSE jsonb_build_object('id',l.id,'name',concat_ws(' ',l."firstName",l."lastName")) END "launchedBy"
      FROM sms_campaigns c LEFT JOIN users a ON a.id=c."createdById" LEFT JOIN users l ON l.id=c."launchedById" WHERE c.id=ANY($1::uuid[])
      ORDER BY c."createdAt" DESC,c.id DESC`,
      [ids],
    );
    const groupedStats = await m.query(
      `SELECT "campaignId",count(*)::int recipients,
      count(*) FILTER(WHERE status IN ('queued','sending'))::int queued,
      count(*) FILTER(WHERE status IN ('sent','delivered'))::int sent,
      count(*) FILTER(WHERE status='delivered')::int delivered, count(*) FILTER(WHERE status='failed')::int failed,
      count(*) FILTER(WHERE status='skipped')::int skipped,
      coalesce(sum(segments) FILTER(WHERE status IN ('sent','delivered')),0)::int segments,
      (SELECT count(*)::int FROM sms_opt_outs o WHERE o."campaignId"=r."campaignId" AND source='link') "optOuts"
      FROM sms_campaign_recipients r WHERE "campaignId"=ANY($1::uuid[]) GROUP BY "campaignId"`,
      [ids],
    );
    const failures = await m.query(
      `SELECT "campaignId","errorCode" code,count(*)::int count FROM sms_campaign_recipients
      WHERE "campaignId"=ANY($1::uuid[]) AND status='failed' GROUP BY "campaignId","errorCode" ORDER BY count(*) DESC`,
      [ids],
    );
    const byId = new Map(groupedStats.map((r) => [r.campaignId, r]));
    return rows.map((c) => {
      const {
        requestKey,
        createdById,
        launchedById,
        testSentAt,
        testRevision,
        ...visible
      } = c;
      const { campaignId, ...stats } = (byId.get(c.id) ?? {
        recipients: 0,
        queued: 0,
        sent: 0,
        delivered: 0,
        failed: 0,
        skipped: 0,
        segments: 0,
        optOuts: 0,
      }) as Record<string, number>;
      return {
        ...visible,
        test: testSentAt
          ? { sentAt: testSentAt, revision: testRevision }
          : null,
        stats:
          c.status === 'draft'
            ? null
            : { ...stats, credits: stats.segments * this.config.credits },
        failures: failures
          .filter((f) => f.campaignId === c.id)
          .map(({ code, count }) => ({ code, count })),
      };
    });
  }
  async recipients(m: EntityManager, id: string, page: SmsPageDto) {
    const args = [id, page.status ?? null];
    const where = `"campaignId"=$1 AND ($2::text IS NULL OR CASE WHEN r.status='sending' THEN 'queued' ELSE r.status END=$2)`;
    const [count] = await m.query(
      `SELECT count(*)::int total FROM sms_campaign_recipients r WHERE ${where}`,
      args,
    );
    const items = await m.query(
      `SELECT r.id,r.phone,coalesce(u."firstName",'') name,
      CASE WHEN r.status='sending' THEN 'queued' ELSE r.status END status,r.segments,r."errorCode",r."sentAt",r."deliveredAt"
      FROM sms_campaign_recipients r LEFT JOIN users u ON u.id=r."userId" WHERE ${where} ORDER BY r."createdAt",r.id LIMIT $3 OFFSET $4`,
      [...args, page.limit, (page.page - 1) * page.limit],
    );
    return {
      items: items.map((r) => ({ ...r, phone: maskPhone(r.phone) })),
      total: count.total,
      page: page.page,
      limit: page.limit,
    };
  }
}
