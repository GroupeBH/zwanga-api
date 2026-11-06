import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { MobileConfig } from './mobile.config';
import {
  MobileCampaignDto,
  MobileLaunchDto,
  MobilePageDto,
  MobileRevisionDto,
} from './mobile.dto';
import { campaignCategory, nativeBuild } from './mobile-policy';
import { mobileAudit, requestHash } from './mobile-audit';
import { installationProof } from './mobile-installations.service';
import { MOBILE_AUDIENCE_SQL, mobileTick } from './mobile-campaign-delivery';
import { StoreAccess } from '../store-management/store.permissions';

@Injectable()
export class MobileCampaignsService {
  private readonly logger = new Logger(MobileCampaignsService.name);
  constructor(
    private readonly db: DataSource,
    private readonly config: MobileConfig,
    private readonly access: StoreAccess,
  ) {}
  async save(actor: string, dto: MobileCampaignDto, revision?: number) {
    this.config.assertEnabled();
    if (
      Date.parse(dto.expiresAt) <= Date.now() ||
      Date.parse(dto.expiresAt) > Date.now() + 30 * 86400000 ||
      !dto.title.trim() ||
      !dto.body.trim()
    )
      throw new BadRequestException(
        'La campagne doit expirer dans les 30 prochains jours.',
      );
    const audience = {
      ...dto.audience,
      ...(dto.audience.belowBuild
        ? { belowBuild: nativeBuild(dto.audience.belowBuild) }
        : {}),
    };
    if (audience.belowBuild && !audience.platform)
      throw new BadRequestException(
        'Un seuil de build exige une plateforme précise.',
      );
    const hash = requestHash({
      title: dto.title,
      body: dto.body,
      kind: dto.kind,
      audience,
      expiresAt: dto.expiresAt,
    });
    return this.db.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `mobile:campaign:${dto.id}`,
      ]);
      const [old] = await m.query(
        `SELECT * FROM mobile_campaigns WHERE id=$1 FOR UPDATE`,
        [dto.id],
      );
      if (revision === undefined && old) {
        if (old.requestHash !== hash || old.createdBy !== actor)
          throw new ConflictException('Identifiant déjà utilisé.');
        return old;
      }
      if (
        revision !== undefined &&
        (!old ||
          old.revision !== revision ||
          !['draft', 'approved'].includes(old.state))
      )
        throw new ConflictException('Campagne modifiée ou déjà lancée.');
      const [row] = await m.query(
        `INSERT INTO mobile_campaigns (id,title,body,kind,category,audience,"expiresAt","createdBy","requestHash")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,kind=EXCLUDED.kind,
        category=EXCLUDED.category,audience=EXCLUDED.audience,"expiresAt"=EXCLUDED."expiresAt","requestHash"=EXCLUDED."requestHash",
        "createdBy"=EXCLUDED."createdBy",state='draft',"approvedBy"=NULL,revision=mobile_campaigns.revision+1,"updatedAt"=now() RETURNING *`,
        [
          dto.id,
          dto.title,
          dto.body,
          dto.kind,
          campaignCategory(dto.kind),
          JSON.stringify(audience),
          dto.expiresAt,
          actor,
          hash,
        ],
      );
      await mobileAudit(m, actor, 'campaign.save', row.id, {
        revision: row.revision,
        category: row.category,
      });
      return row;
    });
  }
  async preview(id: string) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      await m.query(`SET LOCAL statement_timeout='5s'`);
      const [campaign] = await m.query(
        'SELECT * FROM mobile_campaigns WHERE id=$1',
        [id],
      );
      if (!campaign) throw new NotFoundException();
      const [row] = await m.query(
        `SELECT count(*)::int AS eligible FROM app_update_installations c
        CROSS JOIN mobile_campaigns m WHERE m.id=$1 AND ${MOBILE_AUDIENCE_SQL}`,
        [id],
      );
      return {
        campaign,
        eligibleInstallations: row.eligible,
        estimateOnly: true,
        requiresFreshConsentAtSend: true,
      };
    });
  }
  async action(
    actor: string,
    id: string,
    action: 'approve' | 'launch' | 'cancel',
    dto: MobileLaunchDto | MobileRevisionDto,
  ) {
    this.config.assertEnabled();
    if (action === 'launch' && !this.config.campaignsEnabled)
      throw new ConflictException('Envoi des campagnes non activé.');
    return this.db.transaction(async (m) => {
      const [row] = await m.query(
        `SELECT * FROM mobile_campaigns WHERE id=$1 FOR UPDATE`,
        [id],
      );
      if (!row) throw new NotFoundException();
      if (row.revision !== dto.revision)
        throw new ConflictException(
          'Rechargez la campagne avant de confirmer.',
        );
      let state: string;
      if (action === 'approve') {
        if (row.createdBy === actor)
          throw new ForbiddenException(
            'Un autre administrateur doit approuver cette campagne.',
          );
        if (row.state !== 'draft')
          throw new ConflictException('Seul un brouillon peut être approuvé.');
        state = 'approved';
      } else if (action === 'launch') {
        if (row.state !== 'approved' || !row.approvedBy)
          throw new ConflictException('Approbation requise.');
        state = 'scheduled';
      } else {
        if (row.state === 'cancelled') return row;
        state = 'cancelled';
      }
      const scheduledAt =
        action === 'launch'
          ? ((dto as MobileLaunchDto).scheduledAt ?? new Date().toISOString())
          : null;
      if (
        action !== 'cancel' &&
        (+new Date(row.expiresAt) <= Date.now() ||
          (scheduledAt && Date.parse(scheduledAt) >= +new Date(row.expiresAt)))
      )
        throw new BadRequestException('Période d’envoi expirée ou invalide.');
      const [updated] = await m.query(
        `WITH updated AS (UPDATE mobile_campaigns SET state=$2,
        "approvedBy"=CASE WHEN $3='approve' THEN $4 ELSE "approvedBy" END,
        "launchedBy"=CASE WHEN $3='launch' THEN $4 ELSE "launchedBy" END,
        "scheduledAt"=COALESCE($5::timestamptz,"scheduledAt"),"updatedAt"=now(),revision=revision+1 WHERE id=$1 RETURNING *) SELECT * FROM updated`,
        [id, state, action, actor, scheduledAt],
      );
      await mobileAudit(m, actor, `campaign.${action}`, id, {
        revision: updated.revision,
      });
      return updated;
    });
  }
  @Cron('*/10 * * * * *', { waitForCompletion: true })
  async enqueue() {
    if (!this.config.campaignsEnabled) return;
    try {
      await this.db.transaction(async (m) => {
        await m.query(`SET LOCAL statement_timeout='5s'`);
        if (!(await mobileTick(m, 'campaign-enqueue', 30))) return;
        const [campaign] =
          await m.query(`SELECT * FROM mobile_campaigns WHERE state IN ('scheduled','running')
          AND "scheduledAt"<=now() AND "nextBatchAt"<=now() ORDER BY "nextBatchAt",id LIMIT 1 FOR UPDATE SKIP LOCKED`);
        if (!campaign) return;
        // Revoked administrative permissions must stop scheduled work too.
        for (const [actor, permission] of [
          [campaign.approvedBy, 'mobile.campaigns.approve'],
          [campaign.launchedBy, 'mobile.campaigns.launch'],
        ] as const) {
          const [user] = await m.query(
            'SELECT id,role FROM users WHERE id=$1 AND "isActive"',
            [actor],
          );
          if (
            !user ||
            !(await this.access.permissions(user.id, user.role)).includes(
              permission,
            )
          ) {
            await m.query(
              `UPDATE mobile_campaigns SET state='cancelled',"updatedAt"=now() WHERE id=$1`,
              [campaign.id],
            );
            await mobileAudit(
              m,
              null,
              'campaign.permission_revoked',
              campaign.id,
            );
            return;
          }
        }
        if (+new Date(campaign.expiresAt) <= Date.now()) {
          await m.query(
            `UPDATE mobile_campaigns SET state='completed',"updatedAt"=now() WHERE id=$1`,
            [campaign.id],
          );
          return;
        }
        await m.query(
          `UPDATE mobile_campaigns SET state='running',"startedAt"=COALESCE("startedAt",now()),"nextBatchAt"=now()+interval '30 seconds' WHERE id=$1`,
          [campaign.id],
        );
        const [backlog] =
          await m.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM notifications WHERE data->>'type'='mobile_campaign'
          AND status='pending' AND "isActive" LIMIT 200) b`);
        if (backlog.n >= 200) return;
        const candidates = await m.query(
          `SELECT c.id FROM app_update_installations c CROSS JOIN mobile_campaigns m WHERE m.id=$1
          AND (m."cursorId" IS NULL OR c.id>m."cursorId") AND c."createdAt"<=m."startedAt" AND ${MOBILE_AUDIENCE_SQL}
          ORDER BY c.id LIMIT 10`,
          [campaign.id],
        );
        for (const candidate of candidates) {
          const id = randomUUID();
          const [notification] = await m.query(
            `INSERT INTO notifications (id,"eventKey","userId","fcmToken",title,body,data,"isAutomatic",status,"isActive")
            VALUES ($1,$2,NULL,'',$3,$4,$5,false,'pending',true) ON CONFLICT ("eventKey") DO NOTHING RETURNING id`,
            [
              id,
              `mobile-campaign:${campaign.id}:${candidate.id}`,
              campaign.title,
              campaign.body,
              JSON.stringify({
                type: 'mobile_campaign',
                installationId: candidate.id,
                campaignId: campaign.id,
                notificationId: id,
                expiresAt: campaign.expiresAt,
                navigateTo: '/mobile/communications',
              }),
            ],
          );
          if (notification)
            await m.query(
              `INSERT INTO mobile_campaign_deliveries ("campaignId","installationId","notificationId")
            VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
              [campaign.id, candidate.id, id],
            );
        }
        await m.query(
          `UPDATE mobile_campaigns SET "cursorId"=COALESCE($2::uuid,"cursorId"),state=$3,"updatedAt"=now() WHERE id=$1`,
          [
            campaign.id,
            candidates.at(-1)?.id ?? null,
            candidates.length < 10 ? 'completed' : 'running',
          ],
        );
      });
    } catch {
      this.logger.warn(
        'Mobile campaign enqueue deferred; durable state preserved.',
      );
    }
  }
  async list(q: MobilePageDto) {
    this.config.assertEnabled();
    const items = await this.db.query(
      `SELECT * FROM mobile_campaigns ORDER BY "createdAt" DESC,id LIMIT $1 OFFSET $2`,
      [q.limit, (q.page - 1) * q.limit],
    );
    return { items, page: q.page, limit: q.limit };
  }
  async stats(id: string) {
    this.config.assertEnabled();
    const [stats] = await this.db.query(
      `SELECT count(*)::int AS queued,
      count(*) FILTER (WHERE n.status='sent')::int AS "providerAccepted",
      count(*) FILTER (WHERE n.status='failed' AND n."isActive")::int AS failed,
      count(*) FILTER (WHERE NOT n."isActive")::int AS suppressed,
      count(*) FILTER (WHERE n."pushPermanentFailure")::int AS "permanentFailures",
      count(*) FILTER (WHERE n.data->>'deliveryFailureCode'='INVALID_PUSH_TOKEN')::int AS "invalidTokens",
      count(*) FILTER (WHERE d."openedAt" IS NOT NULL)::int AS "instrumentedOpens"
      FROM mobile_campaign_deliveries d JOIN notifications n ON n.id=d."notificationId" WHERE d."campaignId"=$1`,
      [id],
    );
    return {
      ...stats,
      deliveredToDevice: null,
      seenByHuman: null,
      attributedConversions: null,
      attribution: 'not_instrumented',
      acceptanceIsNotDelivery: true,
    };
  }
  async communications(
    id: string,
    secret: string | undefined,
    q: MobilePageDto,
  ) {
    this.config.assertEnabled();
    await installationProof(this.db.manager, id, secret);
    const items = await this.db.query(
      `SELECT m.id,m.title,m.body,m.kind,d."openedAt",d."createdAt" FROM mobile_campaign_deliveries d
      JOIN mobile_campaigns m ON m.id=d."campaignId" JOIN app_update_installations c ON c.id=d."installationId"
      WHERE c.id=$1 AND m.state IN ('running','completed') AND m."expiresAt">now() AND ${MOBILE_AUDIENCE_SQL}
      ORDER BY d."createdAt" DESC,m.id LIMIT $2 OFFSET $3`,
      [id, q.limit, (q.page - 1) * q.limit],
    );
    return { items, page: q.page, limit: q.limit };
  }
  async opened(id: string, secret: string | undefined, campaignId: string) {
    this.config.assertEnabled();
    await installationProof(this.db.manager, id, secret);
    const rows = await this.db.query(
      `WITH updated AS (UPDATE mobile_campaign_deliveries SET "openedAt"=COALESCE("openedAt",now())
      WHERE "installationId"=$1 AND "campaignId"=$2 RETURNING "campaignId") SELECT * FROM updated`,
      [id, campaignId],
    );
    if (!rows.length) throw new NotFoundException();
    return {
      recorded: true,
      source: 'client_reported_open_not_proof_of_reading',
    };
  }
}
