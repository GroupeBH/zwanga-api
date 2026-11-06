import { randomUUID } from 'node:crypto';
import { EntityManager, Repository } from 'typeorm';
import {
  Notification,
  NotificationStatus,
} from '../notifications/entities/notification.entity';
import {
  heartbeatPushClaim,
  ownPushClaim,
} from '../notifications/notification-push-claim';

/** One budget shared by all replicas, held only during the short SQL claim. */
export async function mobileTick(
  m: EntityManager,
  key: string,
  seconds: number,
): Promise<boolean> {
  const rows = await m.query(
    `INSERT INTO mobile_operation_ticks (key,"nextAt") VALUES ($1,now()+make_interval(secs=>$2))
    ON CONFLICT (key) DO UPDATE SET "nextAt"=EXCLUDED."nextAt" WHERE mobile_operation_ticks."nextAt"<=now() RETURNING key`,
    [key, seconds],
  );
  return rows.length > 0;
}

// c=installation, m=campaign. All expressions are static, audience values are validated DTO data.
export const MOBILE_AUDIENCE_SQL = `NOT (c."mobileMetadata" ? 'deletedAt')
  AND c."mobileMetadata"->>'environment'=m.audience->>'environment'
  AND (m.audience->>'platform' IS NULL OR c.platform=m.audience->>'platform')
  AND (m.audience->>'belowBuild' IS NULL OR string_to_array(c.build,'.')::int[] < string_to_array(m.audience->>'belowBuild','.')::int[])
  AND (m.audience->>'inactiveDays' IS NULL OR c."updatedAt"<=now()-make_interval(days=>(m.audience->>'inactiveDays')::int))
  AND (CASE m.audience->>'population'
    WHEN 'all' THEN true WHEN 'anonymous' THEN c."userId" IS NULL WHEN 'linked' THEN c."userId" IS NOT NULL
    ELSE EXISTS (SELECT 1 FROM users u WHERE u.id=c."userId" AND u."isActive" AND u.role::text=m.audience->>'population') END)
  AND (c."userId" IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id=c."userId" AND u."isActive"))
  AND c."mobileMetadata"->'preferences'->>m.category='true'
  AND c.enabled AND c."pushToken" IS NOT NULL AND c."mobileMetadata"->>'pushProvider'='fcm'
  AND c."mobileMetadata"->>'notificationPermission' IN ('granted','provisional')
  AND c."updatedAt">now()-interval '180 days'`;

export async function mobileCampaignToken(
  manager: EntityManager,
  data: Record<string, any>,
): Promise<string | null> {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    !uuid.test(data.installationId ?? '') ||
    !uuid.test(data.campaignId ?? '')
  )
    return null;
  const [row] = await manager.query(
    `SELECT c."pushToken" FROM app_update_installations c
    JOIN mobile_campaign_deliveries d ON d."installationId"=c.id
    JOIN mobile_campaigns m ON m.id=d."campaignId" WHERE c.id=$1 AND m.id=$2
    AND m.state IN ('running','completed') AND m."expiresAt">now() AND ${MOBILE_AUDIENCE_SQL}
    AND NOT EXISTS (SELECT 1 FROM (VALUES (m."approvedBy",'mobile.campaigns.approve'),(m."launchedBy",'mobile.campaigns.launch')) a(id,permission)
      LEFT JOIN users u ON u.id=a.id LEFT JOIN store_access_grants g ON g."userId"=u.id
      WHERE u.id IS NULL OR NOT u."isActive" OR u.role NOT IN ('super_admin','admin','marketer')
        OR (u.role<>'super_admin' AND NOT COALESCE(g.permissions ? a.permission,false)))`,
    [data.installationId, data.campaignId],
  );
  return row?.pushToken ?? null;
}

/** Dedicated low-volume lane. Existing urgent/financial queues never consume campaign work. */
export async function drainMobileCampaigns(
  repo: Repository<Notification>,
  send: (n: Notification) => Promise<boolean>,
  warn: () => void,
) {
  const rows = await repo.manager.transaction(async (m) => {
    await m.query(`SET LOCAL statement_timeout='5s'`);
    if (!(await mobileTick(m, 'campaign-send', 5))) return [];
    const r = m.getRepository(Notification);
    const items = await r
      .createQueryBuilder('n')
      .where(
          `n.data->>'type'='mobile_campaign' AND n."isActive"=true
      AND n.status IN ('pending','failed') AND n."pushPermanentFailure"=false AND n."pushAttempts"<5
      AND (n."pushRetryAt" IS NULL OR n."pushRetryAt"<=now())
      AND (n."errorMessage" IS NULL OR n.status='failed' OR n."updatedAt"<now()-interval '20 seconds')`,
      )
      .orderBy('n.createdAt', 'ASC')
      .take(2)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getMany();
    for (const n of items) {
      n.status = NotificationStatus.PENDING;
      n.errorMessage = `CRITICAL_PUSH_RETRY_CLAIMED:${randomUUID()}`;
    }
    return items.length ? r.save(items) : [];
  });
  await Promise.all(
    rows.map(async (n) => {
      ownPushClaim(n, n.errorMessage!);
      const stop = heartbeatPushClaim(repo, n, warn);
      try {
        await send(n);
      } catch {
        warn();
      } finally {
        stop();
      }
    }),
  );
}
