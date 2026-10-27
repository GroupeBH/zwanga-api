import type { EntityManager } from 'typeorm';
import { UPDATE_REQUIRED_SQL } from './app-update.policy';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const INSTALLATION_AUDIENCE_SQL = `r.available = true AND c.platform = r.platform
  AND c.enabled = true AND c."pushToken" IS NOT NULL AND c."updatedAt" > now() - interval '90 days'
  AND ${UPDATE_REQUIRED_SQL}`;
export const CAMPAIGN_AUDIENCE_SQL = `m.active = true AND m."createdAt" > now() - interval '7 days'
  AND c."createdAt" <= m."createdAt" AND ${INSTALLATION_AUDIENCE_SQL}`;

/** Fresh consent, current token, active release, and campaign expiry on EVERY attempt. */
export async function installationUpdateToken(
  manager: EntityManager,
  data: Record<string, unknown>,
): Promise<string | null> {
  const id = data.installationId,
    release = data.releaseId,
    campaign = data.campaignId;
  if (
    typeof id !== 'string' ||
    !UUID.test(id) ||
    typeof release !== 'string' ||
    !/^\d{1,18}$/.test(release) ||
    (campaign !== undefined &&
      (typeof campaign !== 'string' || !UUID.test(campaign)))
  )
    return null;
  const rows: { pushToken: string }[] = await manager.query(
    `SELECT c."pushToken"
    FROM app_update_installations c JOIN app_store_releases r ON r.platform = c.platform
    ${campaign ? 'JOIN app_update_campaigns m ON m."releaseId" = r.id AND m.id = $3' : ''}
    WHERE c.id = $1 AND r.id = $2 AND ${campaign ? CAMPAIGN_AUDIENCE_SQL : INSTALLATION_AUDIENCE_SQL}`,
    campaign ? [id, release, campaign] : [id, release],
  );
  return rows[0]?.pushToken ?? null;
}
