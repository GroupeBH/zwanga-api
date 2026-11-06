import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { MobileConfig } from './mobile.config';
import {
  MobilePageDto,
  MobilePolicyDto,
  MobileRevisionDto,
  MobileVersionCheckDto,
} from './mobile.dto';
import {
  compareBuild,
  nativeBuild,
  policyDecision,
  validStoreUrl,
} from './mobile-policy';
import { installationProof } from './mobile-installations.service';
import { mobileAudit, requestHash } from './mobile-audit';
import { StoreConfig } from '../store-management/store.config';

@Injectable()
export class MobilePoliciesService {
  constructor(
    private readonly db: DataSource,
    private readonly config: MobileConfig,
    private readonly stores: StoreConfig,
  ) {}
  async save(actor: string, dto: MobilePolicyDto, revision?: number) {
    this.config.assertEnabled();
    if (
      !validStoreUrl(dto.platform, dto.storeUrl) ||
      (dto.expiresAt &&
        Date.parse(dto.expiresAt) <= Date.parse(dto.effectiveAt))
    )
      throw new BadRequestException('URL Store ou période invalide.');
    if (dto.mode !== 'REQUIRED' && dto.blockedFeatures.length)
      throw new BadRequestException(
        'Seul REQUIRED peut limiter de nouvelles opérations.',
      );
    const body = {
      ...dto,
      minimumBuild: nativeBuild(dto.minimumBuild),
      minimumVersion: dto.minimumVersion
        ? nativeBuild(dto.minimumVersion)
        : null,
    };
    delete (body as any).revision;
    const hash = requestHash(body);
    return this.db.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `mobile:policy:${dto.id}`,
      ]);
      const [old] = await m.query(
        `SELECT * FROM mobile_update_policies WHERE id=$1 FOR UPDATE`,
        [dto.id],
      );
      if (revision === undefined && old) {
        if (old.requestHash !== hash || old.createdBy !== actor)
          throw new ConflictException('Identifiant déjà utilisé.');
        return old;
      }
      if (revision !== undefined && (!old || old.revision !== revision))
        throw new ConflictException('La politique a changé.');
      const [release] = await m.query(
        `SELECT * FROM app_store_releases WHERE id=$1 AND platform=$2 FOR SHARE`,
        [dto.releaseId, dto.platform],
      );
      if (!release || compareBuild(body.minimumBuild, release.build) > 0)
        throw new BadRequestException(
          'Version minimale supérieure à la release cible ou release inconnue.',
        );
      const values = [
        dto.id,
        dto.platform,
        dto.environment,
        dto.releaseId,
        dto.mode,
        body.minimumBuild,
        body.minimumVersion,
        dto.message,
        dto.storeUrl,
        dto.audience,
        JSON.stringify(dto.blockedFeatures),
        dto.effectiveAt,
        dto.expiresAt ?? null,
        dto.availabilityConfirmed,
        dto.availabilityEvidence,
        hash,
        actor,
      ];
      const [row] = await m.query(
        `INSERT INTO mobile_update_policies
        (id,platform,environment,"releaseId",mode,"minimumBuild","minimumVersion",message,"storeUrl",audience,"blockedFeatures",
        "effectiveAt","expiresAt","availabilityConfirmed","availabilityEvidence","requestHash","createdBy")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (id) DO UPDATE SET platform=EXCLUDED.platform,environment=EXCLUDED.environment,"releaseId"=EXCLUDED."releaseId",
        mode=EXCLUDED.mode,"minimumBuild"=EXCLUDED."minimumBuild","minimumVersion"=EXCLUDED."minimumVersion",message=EXCLUDED.message,
        "storeUrl"=EXCLUDED."storeUrl",audience=EXCLUDED.audience,"blockedFeatures"=EXCLUDED."blockedFeatures",
        "effectiveAt"=EXCLUDED."effectiveAt","expiresAt"=EXCLUDED."expiresAt","availabilityConfirmed"=EXCLUDED."availabilityConfirmed",
        "availabilityEvidence"=EXCLUDED."availabilityEvidence","requestHash"=EXCLUDED."requestHash",active=false,
        revision=mobile_update_policies.revision+1,"updatedAt"=now() RETURNING *`,
        values,
      );
      await mobileAudit(m, actor, 'policy.save', row.id, {
        before: old ?? null,
        after: row,
      });
      return row;
    });
  }
  /** Imported data can veto an administrator's confirmation; never infer 100% from a missing field. */
  async distributionConflict(m: EntityManager, policy: any): Promise<boolean> {
    const platform = policy.platform === 'android' ? 'google' : 'apple';
    const records = await m.query(
      `SELECT content FROM store_records WHERE platform=$1 AND "appId"=$2 AND kind='release' AND "isCurrent"`,
      [platform, this.stores.appId(platform)],
    );
    if (platform === 'google') {
      const releases = records
        .filter((r) => r.content.track === 'production')
        .flatMap((r) => r.content.releases ?? []);
      const match = releases.filter((r) =>
        (r.versionCodes ?? []).some(
          (v: string) => nativeBuild(v) === nativeBuild(policy.build),
        ),
      );
      return match.some(
        (r) =>
          r.status !== 'completed' ||
          (r.userFraction !== undefined &&
            r.userFraction !== null &&
            Number(r.userFraction) < 1),
      );
    }
    return records.some(
      (r) =>
        r.content.versionString &&
        nativeBuild(r.content.versionString) === nativeBuild(policy.version) &&
        (!['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'].includes(
          r.content.appStoreState,
        ) ||
          (r.content.phasedReleaseState &&
            !['COMPLETE', 'INACTIVE'].includes(r.content.phasedReleaseState))),
    );
  }
  async activate(
    actor: string,
    id: string,
    dto: MobileRevisionDto,
    active: boolean,
  ) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      const [row] = await m.query(
        `SELECT p.*,r.available,r.build,r.version FROM mobile_update_policies p
        JOIN app_store_releases r ON r.id=p."releaseId" WHERE p.id=$1 FOR UPDATE OF p`,
        [id],
      );
      if (!row) throw new NotFoundException();
      if (row.revision !== dto.revision)
        throw new ConflictException('La politique a changé.');
      if (
        active &&
        (!row.available ||
          !row.availabilityConfirmed ||
          (row.expiresAt && +new Date(row.expiresAt) <= Date.now()) ||
          (await this.distributionConflict(m, row)))
      )
        throw new ConflictException(
          'La disponibilité pour toute cette population doit être confirmée, sans déploiement progressif contradictoire.',
        );
      const [updated] = await m.query(
        `WITH updated AS (UPDATE mobile_update_policies SET active=$2,revision=revision+1,"updatedAt"=now() WHERE id=$1 RETURNING *) SELECT * FROM updated`,
        [id, active],
      );
      await mobileAudit(
        m,
        actor,
        active ? 'policy.activate' : 'policy.deactivate',
        id,
        { revision: updated.revision },
      );
      return updated;
    });
  }
  async check(dto: MobileVersionCheckDto, secret?: string) {
    nativeBuild(dto.build);
    if (!this.config.enabled) return policyDecision(undefined, dto.build);
    let population = 'unknown';
    if (dto.installationId) {
      const row = await installationProof(
        this.db.manager,
        dto.installationId,
        secret,
      );
      population = row.userId ? 'linked' : 'anonymous';
    }
    const policies = await this.db.query(
      `SELECT p.*,r.available,r.version,r.build FROM mobile_update_policies p
      JOIN app_store_releases r ON r.id=p."releaseId"
      WHERE p.active AND p.platform=$1 AND p.environment=$2 AND p."effectiveAt"<=now()
        AND (p."expiresAt" IS NULL OR p."expiresAt">now()) AND (p.audience='all' OR p.audience=$3)
      ORDER BY p."effectiveAt" DESC,p."updatedAt" DESC,p.id DESC LIMIT 1`,
      [dto.platform, dto.environment, population],
    );
    const policy = policies[0];
    if (policy && (await this.distributionConflict(this.db.manager, policy)))
      return {
        ...policyDecision(undefined, dto.build),
        reason: 'distribution_not_confirmed',
      };
    return policyDecision(policy, dto.build);
  }
  async list(q: MobilePageDto) {
    this.config.assertEnabled();
    const items = await this.db.query(
      `SELECT * FROM mobile_update_policies WHERE ($1::text IS NULL OR platform=$1)
      ORDER BY "updatedAt" DESC,id LIMIT $2 OFFSET $3`,
      [q.platform ?? null, q.limit, (q.page - 1) * q.limit],
    );
    return { items, page: q.page, limit: q.limit };
  }
  async releases(q: MobilePageDto, id?: string) {
    this.config.assertEnabled();
    const items = await this.db.query(
      `SELECT * FROM app_store_releases WHERE ($1::text IS NULL OR platform=$1)
      AND ($2::bigint IS NULL OR id=$2) ORDER BY "publishedAt" DESC,id DESC LIMIT $3 OFFSET $4`,
      [q.platform ?? null, id ?? null, q.limit, (q.page - 1) * q.limit],
    );
    return {
      items,
      page: q.page,
      limit: q.limit,
      availability:
        'administrator_confirmed; store observations available in admin/store-management/versions',
    };
  }
}
