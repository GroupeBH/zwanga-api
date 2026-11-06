import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { InstallationUpdatesService } from '../app-updates/installation-updates.service';
import { MobileConfig } from './mobile.config';
import {
  MobileInstallationDto,
  MobileInstallationPageDto,
  MobilePageDto,
} from './mobile.dto';
import { nativeBuild } from './mobile-policy';

/** A secret proves control of an installation, not identity or a unique human. */
export async function installationProof(
  m: EntityManager,
  id: string,
  secret?: string,
  lock = false,
) {
  if (!secret || !/^[a-zA-Z0-9_-]{64,128}$/.test(secret))
    throw new ForbiddenException('Installation non reconnue.');
  const [row] = await m.query(
    `SELECT id,"secretHash","userId","linkSequence",sequence,"mobileMetadata"
    FROM app_update_installations WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  const hash = createHash('sha256').update(secret).digest('hex');
  if (
    !row ||
    typeof row.secretHash !== 'string' ||
    row.secretHash.length !== hash.length ||
    !timingSafeEqual(Buffer.from(row.secretHash), Buffer.from(hash)) ||
    row.mobileMetadata?.deletedAt
  )
    throw new ForbiddenException('Installation non reconnue.');
  return row;
}
export const MOBILE_INSTALLATION_COLUMNS = `id,platform,version,build,enabled,"createdAt","updatedAt",
  ("userId" IS NOT NULL) AS linked,"firstLinkedAt","linkedAt","mobileMetadata"`;

@Injectable()
export class MobileInstallationsService {
  constructor(
    private readonly db: DataSource,
    private readonly config: MobileConfig,
    private readonly registrations: InstallationUpdatesService,
  ) {}
  async register(
    id: string,
    secret: string | undefined,
    dto: MobileInstallationDto,
  ) {
    this.config.assertEnabled();
    if (
      dto.enabled &&
      !['granted', 'provisional'].includes(dto.notificationPermission)
    )
      throw new BadRequestException('Autorisation de notification requise.');
    const metadata = {
      environment: dto.environment,
      osVersion: dto.osVersion ?? null,
      deviceCategory: dto.deviceCategory ?? null,
      notificationPermission: dto.notificationPermission,
      pushProvider: dto.pushProvider,
      preferences: dto.preferences,
      preferencesUpdatedAt: new Date().toISOString(),
    };
    return this.registrations.register(id, secret, dto, async (m) => {
      await m.query(
        `UPDATE app_update_installations SET "mobileMetadata"=$2 WHERE id=$1`,
        [id, JSON.stringify(metadata)],
      );
      await m.query(
        `INSERT INTO mobile_installation_days ("installationId",day,platform,version)
        VALUES ($1,(now() AT TIME ZONE 'UTC')::date,$2,$3) ON CONFLICT ("installationId",day)
        DO UPDATE SET platform=EXCLUDED.platform,version=EXCLUDED.version`,
        [id, dto.platform, nativeBuild(dto.version)],
      );
    });
  }
  async link(
    id: string,
    secret: string | undefined,
    actorId: string,
    sequence: number,
    unlink = false,
  ) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      const row = await installationProof(m, id, secret, true);
      if (sequence <= Number(row.linkSequence)) return { changed: false };
      if (unlink && row.userId && row.userId !== actorId)
        throw new ForbiddenException(
          'Cette installation est associée à une autre session.',
        );
      // userId comes exclusively from the JWT, never from the public payload.
      await m.query(
        `UPDATE app_update_installations SET "userId"=$2,"linkSequence"=$3,
        "linkedAt"=CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END,
        "firstLinkedAt"=CASE WHEN $2::uuid IS NULL THEN "firstLinkedAt" ELSE COALESCE("firstLinkedAt",now()) END
        WHERE id=$1`,
        [id, unlink ? null : actorId, sequence],
      );
      return { changed: true, linked: !unlink };
    });
  }
  async remove(id: string, secret?: string) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      await installationProof(m, id, secret, true);
      await m.query(
        `UPDATE app_update_installations SET "userId"=NULL,"linkedAt"=NULL,"firstLinkedAt"=NULL,
        enabled=false,"pushToken"=NULL,"tokenHash"=NULL,"mobileMetadata"=jsonb_build_object('deletedAt',now()),"updatedAt"=now() WHERE id=$1`,
        [id],
      );
      await m.query(
        `UPDATE notifications SET "isActive"=false,"fcmToken"='' WHERE id IN
        (SELECT "notificationId" FROM mobile_campaign_deliveries WHERE "installationId"=$1)`,
        [id],
      );
      await m.query(
        'DELETE FROM mobile_campaign_deliveries WHERE "installationId"=$1',
        [id],
      );
      await m.query(
        'DELETE FROM mobile_installation_days WHERE "installationId"=$1',
        [id],
      );
      return { deleted: true, resetInstallationId: true };
    });
  }
  async list(q: MobileInstallationPageDto) {
    this.config.assertEnabled();
    const values: unknown[] = [];
    const where = [`NOT ("mobileMetadata" ? 'deletedAt')`];
    if (q.platform) {
      values.push(q.platform);
      where.push(`platform=$${values.length}`);
    }
    if (q.version) {
      values.push(nativeBuild(q.version));
      where.push(`version=$${values.length}`);
    }
    if (q.environment) {
      values.push(q.environment);
      where.push(`"mobileMetadata"->>'environment'=$${values.length}`);
    }
    if (q.from) {
      values.push(q.from);
      where.push(`"createdAt">=$${values.length}::date`);
    }
    if (q.to) {
      values.push(q.to);
      where.push(`"createdAt"<$${values.length}::date+interval '1 day'`);
    }
    if (q.population && q.population !== 'all')
      where.push(`"userId" IS ${q.population === 'linked' ? 'NOT ' : ''}NULL`);
    if (q.reachable)
      where.push(
        q.reachable === 'yes'
          ? `enabled AND "pushToken" IS NOT NULL`
          : `(NOT enabled OR "pushToken" IS NULL)`,
      );
    values.push(q.limit + 1, (q.page - 1) * q.limit);
    const items = await this.db.query(
      `SELECT ${MOBILE_INSTALLATION_COLUMNS} FROM app_update_installations
      WHERE ${where.join(' AND ')} ORDER BY "createdAt" DESC,id LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return {
      items: items.slice(0, q.limit),
      hasMore: items.length > q.limit,
      page: q.page,
      limit: q.limit,
      identity: 'installations_not_unique_people',
      reachability: 'token_present_not_delivery_guarantee',
    };
  }
  async history(id: string, q: MobilePageDto) {
    this.config.assertEnabled();
    const items = await this.db.query(
      `SELECT day,platform,version FROM mobile_installation_days WHERE "installationId"=$1
      ORDER BY day DESC LIMIT $2 OFFSET $3`,
      [id, q.limit, (q.page - 1) * q.limit],
    );
    return {
      items,
      page: q.page,
      limit: q.limit,
      definition: 'one_observed_contact_per_installation_per_UTC_day',
    };
  }
}
