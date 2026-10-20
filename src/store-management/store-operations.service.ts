import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { StoreConfig } from './store.config';
import { StoreRepository } from './store.repository';
import { StoreRecord, StoreSyncJob } from './store.entities';
import {
  StoreAccessGrant,
  StoreAlertRule,
  StoreAuditLog,
  StoreIntegration,
  StoreReleaseIncident,
  StoreReviewWorkflow,
} from './store-operations.entities';
import {
  StoreApprovalDto,
  StoreDraftDto,
  StoreGrantDto,
  StoreIncidentDto,
  StoreIntegrationDto,
  StorePublishDto,
  StoreReviewStateDto,
  StoreAlertRuleDto,
  StoreAlertRulePatchDto,
} from './store-operations.dto';
import { STORE_PROFILES, StoreAccess } from './store.permissions';
import { StorePageDto } from './store.dto';
import { UserRole } from '../users/entities/user.entity';
import type { StorePlatform } from './store.types';
import { METRIC_CATALOG } from './store.reports';

export const STORE_CADENCES = {
  connection: 360,
  reviews: 60,
  catalog: 120,
  reports: 1440,
  vitals: 1440,
};
export const storeAudit = (
  m: EntityManager,
  actorId: string | null,
  action: string,
  subjectId: string,
  details: Record<string, unknown> = {},
) =>
  m.getRepository(StoreAuditLog).save({ actorId, action, subjectId, details });

@Injectable()
export class StoreOperationsService {
  constructor(
    private readonly config: StoreConfig,
    private readonly repository: StoreRepository,
    private readonly access: StoreAccess,
  ) {}
  private get db() {
    return this.repository.db;
  }
  private async record(m: EntityManager, id: string, kind?: string) {
    const record = await m.getRepository(StoreRecord).findOneBy({ id });
    if (
      !record ||
      record.appId !== this.config.appId(record.platform) ||
      (kind && record.kind !== kind)
    )
      throw new NotFoundException('Ressource Store introuvable.');
    return record;
  }
  private async backoffice(m: EntityManager, id: string) {
    const [user] = await m.query(
      `SELECT id, role FROM users WHERE id=$1 AND "isActive" AND role IN ('admin','super_admin','marketer')`,
      [id],
    );
    if (!user)
      throw new BadRequestException(
        'Le destinataire doit être un compte administratif actif.',
      );
    return user;
  }
  async integrations() {
    this.config.assertEnabled();
    const settings = await this.db.getRepository(StoreIntegration).find();
    const last = await this.db
      .getRepository(StoreSyncJob)
      .createQueryBuilder('j')
      .where(
        "j.state='succeeded' AND j.task NOT IN ('reply','analytics_request','connection')",
      )
      .andWhere(
        '(j.platform=:google AND j.appId=:googleApp) OR (j.platform=:apple AND j.appId=:appleApp)',
        {
          google: 'google',
          googleApp: this.config.appId('google'),
          apple: 'apple',
          appleApp: this.config.appId('apple'),
        },
      )
      .select('j.platform', 'platform')
      .addSelect('MAX(j.completedAt)', 'lastSync')
      .groupBy('j.platform')
      .getRawMany();
    return settings.map((s) => ({
      ...s,
      appId: this.config.appId(s.platform),
      missingVariables: this.config.missing(s.platform),
      state: !s.enabled
        ? 'disabled'
        : this.config.missing(s.platform).length
          ? 'unconfigured'
          : !s.checkedAt
            ? 'unchecked'
            : s.errorCode
              ? 'error'
              : 'connected',
      lastSync: last.find((l) => l.platform === s.platform)?.lastSync ?? null,
      schedule: { ...STORE_CADENCES, ...s.schedule },
      nextSchedulerCheck:
        this.config.scheduled && s.enabled
          ? new Date((Math.floor(Date.now() / 60000) + 1) * 60000).toISOString()
          : null,
      writePermissions:
        'Not probed by a read-only connection test; provider permissions must also be granted in the console.',
    }));
  }
  async configure(
    actor: string,
    platform: StorePlatform,
    dto: StoreIntegrationDto,
  ) {
    this.config.assertEnabled();
    if (!Object.keys(dto).length)
      throw new BadRequestException('Aucun paramètre fourni.');
    return this.db.transaction(async (m) => {
      const row = await m
        .getRepository(StoreIntegration)
        .findOne({ where: { platform }, lock: { mode: 'pessimistic_write' } });
      if (!row) throw new NotFoundException();
      if (dto.enabled !== undefined) row.enabled = dto.enabled;
      for (const task of Object.keys(STORE_CADENCES)) {
        const value = dto[(task + 'Minutes') as keyof StoreIntegrationDto];
        if (typeof value === 'number')
          row.schedule = { ...row.schedule, [task]: value };
      }
      await m.getRepository(StoreIntegration).save(row);
      await storeAudit(m, actor, 'integration.configure', platform, {
        enabled: row.enabled,
        schedule: row.schedule,
      });
      return row;
    });
  }
  async grants(query: StorePageDto) {
    this.config.assertEnabled();
    const [items, total] = await this.db
      .getRepository(StoreAccessGrant)
      .findAndCount({
        order: { userId: 'ASC' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      });
    return { items, total, profiles: STORE_PROFILES };
  }
  async grant(actor: string, userId: string, dto: StoreGrantDto) {
    this.config.assertEnabled();
    const permissions =
      dto.profile === 'custom'
        ? (dto.permissions ?? [])
        : [...STORE_PROFILES[dto.profile]];
    return this.db.transaction(async (m) => {
      const user = await this.backoffice(m, userId);
      if (user.role === UserRole.SUPER_ADMIN)
        throw new BadRequestException(
          'Les droits du Super Admin sont définis par son rôle existant.',
        );
      await m
        .getRepository(StoreAccessGrant)
        .upsert(
          { userId, profile: dto.profile, permissions: [...permissions] },
          ['userId'],
        );
      await storeAudit(m, actor, 'access.grant', userId, {
        profile: dto.profile,
        permissions,
      });
      return { userId, profile: dto.profile, permissions };
    });
  }
  private async lockedWorkflow(m: EntityManager, id: string, revision: number) {
    await this.record(m, id, 'review');
    await m
      .getRepository(StoreReviewWorkflow)
      .createQueryBuilder()
      .insert()
      .values({ recordId: id })
      .orIgnore()
      .execute();
    const workflow = await m.getRepository(StoreReviewWorkflow).findOneOrFail({
      where: { recordId: id },
      lock: { mode: 'pessimistic_write' },
    });
    if (workflow.revision !== revision)
      throw new ConflictException(
        'Cet avis a été modifié. Rechargez le détail avant de continuer.',
      );
    if (workflow.publishedJobId) {
      const job = await m
        .getRepository(StoreSyncJob)
        .findOneBy({ id: workflow.publishedJobId });
      if (job && ['pending', 'running', 'unknown'].includes(job.state))
        throw new ConflictException(
          'Une réponse est en attente ou son résultat doit être vérifié sur le store.',
        );
    }
    return workflow;
  }
  async review(id: string) {
    this.config.assertEnabled();
    const record = await this.record(this.db.manager, id, 'review');
    const workflow = await this.db
      .getRepository(StoreReviewWorkflow)
      .findOneBy({ recordId: id });
    return {
      ...record,
      workflow: workflow ?? { recordId: id, revision: 0, status: 'new' },
    };
  }
  async draft(actor: string, id: string, dto: StoreDraftDto) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      const row = await this.lockedWorkflow(m, id, dto.revision);
      const record = await this.record(m, id, 'review');
      const draft = dto.text.trim();
      if (
        !draft ||
        [...draft].length > (record.platform === 'google' ? 350 : 5970)
      )
        throw new BadRequestException('Brouillon vide ou trop long.');
      Object.assign(row, {
        draft,
        preparedBy: actor,
        revision: row.revision + 1,
        status: 'draft',
        approvedBy: null,
        approvedRevision: null,
        publishedJobId: null,
      });
      await m.getRepository(StoreReviewWorkflow).save(row);
      await storeAudit(m, actor, 'review.draft', id, {
        revision: row.revision,
        text: draft,
      });
      return row;
    });
  }
  async submit(actor: string, id: string, revision: number) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      const row = await this.lockedWorkflow(m, id, revision);
      if (!row.draft || row.status !== 'draft')
        throw new BadRequestException(
          'Enregistrez un brouillon avant de demander sa validation.',
        );
      row.status = 'pending_approval';
      await m.getRepository(StoreReviewWorkflow).save(row);
      await storeAudit(m, actor, 'review.submit', id, { revision });
      return row;
    });
  }
  async approve(
    actor: string,
    role: UserRole,
    id: string,
    dto: StoreApprovalDto,
  ) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      const row = await this.lockedWorkflow(m, id, dto.revision);
      if (row.status !== 'pending_approval' || !row.draft)
        throw new ConflictException(
          'Cette réponse n’attend pas de validation.',
        );
      if (
        row.preparedBy === actor &&
        (role !== UserRole.SUPER_ADMIN || !dto.overrideReason?.trim())
      )
        throw new ForbiddenException(
          'Une autre personne doit approuver la réponse.',
        );
      row.approvedBy = actor;
      row.approvedRevision = row.revision;
      row.status = 'approved';
      await m.getRepository(StoreReviewWorkflow).save(row);
      await storeAudit(m, actor, 'review.approve', id, {
        revision: row.revision,
        overrideReason: dto.overrideReason ?? null,
      });
      return row;
    });
  }
  async publish(actor: string, id: string, dto: StorePublishDto) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      const existing = await m
        .getRepository(StoreSyncJob)
        .findOneBy({ requestKey: `manual:${actor}:${dto.requestId}` });
      if (existing) {
        if (
          existing.task !== 'reply' ||
          existing.input.recordId !== id ||
          existing.input.revision !== dto.revision
        )
          throw new ConflictException('Clé de requête déjà utilisée.');
        return existing;
      }
      const record = await this.record(m, id, 'review');
      const row = await this.lockedWorkflow(m, id, dto.revision);
      if (
        row.status !== 'approved' ||
        row.approvedRevision !== row.revision ||
        !row.approvedBy ||
        !row.draft
      )
        throw new ForbiddenException(
          'Une réponse approuvée est obligatoire avant publication.',
        );
      const appId = this.config.assertReady(record.platform);
      const integration = await m
        .getRepository(StoreIntegration)
        .findOneBy({ platform: record.platform });
      if (!integration?.enabled)
        throw new ConflictException('Intégration désactivée.');
      const job = await this.repository.enqueue(
        {
          actorId: actor,
          platform: record.platform,
          appId,
          task: 'reply',
          lane: 'reviews',
          requestKey: `manual:${actor}:${dto.requestId}`,
          input: {
            from: '1970-01-01',
            to: '1970-01-01',
            recordId: id,
            reply: row.draft,
            revision: row.revision,
          },
        },
        m,
      );
      row.publishedJobId = job.id;
      await m.getRepository(StoreReviewWorkflow).save(row);
      await storeAudit(m, actor, 'review.publish_requested', id, {
        jobId: job.id,
        revision: row.revision,
      });
      return job;
    });
  }
  async reviewState(actor: string, id: string, dto: StoreReviewStateDto) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      const row = await this.lockedWorkflow(m, id, dto.revision);
      if (dto.assigneeId) {
        const user = await this.backoffice(m, dto.assigneeId);
        if (
          !(await this.access.permissions(user.id, user.role)).includes(
            'store.reviews.read',
          )
        )
          throw new BadRequestException(
            'Le responsable doit avoir accès aux avis.',
          );
      }
      if (dto.assigneeId !== undefined) row.assigneeId = dto.assigneeId;
      if (dto.status) row.status = dto.status;
      row.revision++;
      row.approvedBy = null;
      row.approvedRevision = null;
      await m.getRepository(StoreReviewWorkflow).save(row);
      await storeAudit(m, actor, 'review.state', id, {
        status: row.status,
        assigneeId: row.assigneeId,
        revision: row.revision,
      });
      return row;
    });
  }
  async reconcileReply(actor: string, id: string) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      const record = await this.record(m, id, 'review');
      const reference = await m
        .getRepository(StoreReviewWorkflow)
        .findOneBy({ recordId: id });
      if (!reference?.publishedJobId)
        throw new BadRequestException('Aucune publication à rapprocher.');
      const job = await m.getRepository(StoreSyncJob).findOne({
        where: { id: reference.publishedJobId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!job || job.state !== 'unknown')
        throw new ConflictException(
          'Cette opération ne nécessite pas de rapprochement.',
        );
      // Same lock order as worker.finish: job then workflow, avoiding a deadlock
      // when an administrator opens reconciliation as a send is completing.
      const workflow = await m.getRepository(StoreReviewWorkflow).findOne({
        where: { recordId: id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!workflow || workflow.publishedJobId !== job.id)
        throw new ConflictException('Le traitement de cet avis a changé.');
      if (
        record.syncedAt.getTime() <=
          (job.completedAt ?? job.createdAt).getTime() ||
        record.content.response !== job.input.reply
      )
        throw new ConflictException(
          'Relancez la synchronisation des avis. La réponse observée sur le store doit correspondre exactement à la réponse envoyée.',
        );
      job.state = 'succeeded';
      job.errorCode = null;
      job.completedAt = new Date();
      workflow.status = 'responded';
      await m.getRepository(StoreSyncJob).save(job);
      await m.getRepository(StoreReviewWorkflow).save(workflow);
      await storeAudit(m, actor, 'review.reconciled', id, {
        jobId: job.id,
        observedAt: record.syncedAt.toISOString(),
      });
      return workflow;
    });
  }
  async audit(query: StorePageDto) {
    this.config.assertEnabled();
    const [items, total] = await this.db
      .getRepository(StoreAuditLog)
      .findAndCount({
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      });
    return { items, total, page: query.page, limit: query.limit };
  }
  async incident(actor: string, recordId: string, dto: StoreIncidentDto) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      const record = await this.record(m, recordId);
      if (!['release', 'build'].includes(record.kind))
        throw new BadRequestException('Version ou build requis.');
      if (dto.ownerId) await this.backoffice(m, dto.ownerId);
      if (!dto.note.trim())
        throw new BadRequestException('Une note est requise.');
      const result = await m
        .getRepository(StoreReleaseIncident)
        .save({ recordId, ...dto });
      await storeAudit(m, actor, 'release.incident', recordId, {
        incidentId: result.id,
        ...dto,
      });
      return result;
    });
  }
  async incidents(recordId: string, query: StorePageDto) {
    this.config.assertEnabled();
    await this.record(this.db.manager, recordId);
    const [items, total] = await this.db
      .getRepository(StoreReleaseIncident)
      .findAndCount({
        where: { recordId },
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      });
    return { items, total };
  }
  async resolveIncident(actor: string, id: string) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      const incident = await m
        .getRepository(StoreReleaseIncident)
        .findOneBy({ id });
      if (!incident) throw new NotFoundException();
      await this.record(m, incident.recordId);
      incident.resolvedAt ??= new Date();
      await m.getRepository(StoreReleaseIncident).save(incident);
      await storeAudit(m, actor, 'release.incident_resolved', id);
      return incident;
    });
  }
  async rules() {
    this.config.assertEnabled();
    return this.db
      .getRepository(StoreAlertRule)
      .find({ order: { updatedAt: 'DESC' }, take: 100 });
  }
  async rule(actor: string, id: string | null, dto: StoreAlertRuleDto) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      await m.query(
        "SELECT pg_advisory_xact_lock(hashtext('store-alert-rules'))",
      );
      return this.saveRule(m, actor, id, dto);
    });
  }
  async patchRule(actor: string, id: string, dto: StoreAlertRulePatchDto) {
    this.config.assertEnabled();
    return this.db.transaction(async (m) => {
      await m.query(
        "SELECT pg_advisory_xact_lock(hashtext('store-alert-rules'))",
      );
      const row = await m.getRepository(StoreAlertRule).findOneBy({ id });
      if (!row) throw new NotFoundException();
      const changes = Object.fromEntries(
        Object.entries(dto).filter(([, value]) => value !== undefined),
      );
      return this.saveRule(m, actor, id, {
        name: row.name,
        platform: row.platform,
        type: row.type,
        metric: row.metric ?? undefined,
        threshold: row.threshold ?? undefined,
        severity: row.severity,
        enabled: row.enabled,
        recipients: row.recipients,
        email: row.email,
        ...changes,
      });
    });
  }
  private async saveRule(
    m: EntityManager,
    actor: string,
    id: string | null,
    dto: StoreAlertRuleDto,
  ) {
    if (!dto.name.trim()) throw new BadRequestException('Nom requis.');
    if (
      ['metric_above', 'metric_drop_percent'].includes(dto.type) &&
      (!METRIC_CATALOG.some((m) => m.id === dto.metric) ||
        dto.threshold === undefined)
    )
      throw new BadRequestException('Indicateur et seuil requis.');
    if (
      ['negative_review', 'unanswered_reviews'].includes(dto.type) &&
      dto.threshold === undefined
    )
      throw new BadRequestException('Seuil requis.');
    if (
      dto.type === 'negative_review' &&
      (!Number.isInteger(dto.threshold) ||
        dto.threshold! < 1 ||
        dto.threshold! > 5)
    )
      throw new BadRequestException(
        'La note seuil doit être comprise entre 1 et 5.',
      );
    if (dto.type === 'metric_drop_percent' && dto.threshold! > 100)
      throw new BadRequestException(
        'La baisse est exprimée en pourcentage, au maximum 100.',
      );
    for (const userId of dto.recipients) {
      const user = await this.backoffice(m, userId);
      if (
        !(await this.access.permissions(user.id, user.role)).includes(
          'store.alerts.read',
        )
      )
        throw new BadRequestException(
          'Les destinataires doivent avoir accès aux alertes Store.',
        );
    }
    if (!id && (await m.getRepository(StoreAlertRule).count()) >= 100)
      throw new BadRequestException('Maximum 100 règles.');
    if (id && !(await m.getRepository(StoreAlertRule).existsBy({ id })))
      throw new NotFoundException();
    const rule = await m.getRepository(StoreAlertRule).save({
      ...(id ? { id } : {}),
      ...dto,
      platform: dto.platform ?? null,
      metric: dto.metric ?? null,
      threshold: dto.threshold ?? null,
    });
    await storeAudit(m, actor, 'alert.rule', rule.id, { ...dto });
    return rule;
  }
}
