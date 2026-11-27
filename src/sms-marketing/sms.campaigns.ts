import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SmsRepository } from './sms.repository';
import { SmsAudienceService } from './sms.audience';
import { SmsMarketingConfig } from './sms.config';
import { MobishastraMarketingTransport } from './mobishastra-marketing.transport';
import {
  SmsCreateDto,
  SmsDraftDto,
  SmsEstimateDto,
  SmsLaunchDto,
  SmsPageDto,
  SmsUpdateDto,
} from './sms.dto';
import {
  maskPhone,
  permissions,
  smsError,
  validateMessage,
} from './sms.policy';

@Injectable()
export class SmsCampaignsService {
  constructor(
    readonly repository: SmsRepository,
    readonly audience: SmsAudienceService,
    readonly config: SmsMarketingConfig,
    readonly transport: MobishastraMarketingTransport,
  ) {}
  assertConfigured() {
    this.config.assertEnabled();
    if (!this.transport.configured())
      smsError(
        'SMS_NOT_CONFIGURED',
        'Le service SMS promotionnel doit être configuré et confirmé avant envoi.',
        503,
      );
  }
  validate(d: SmsDraftDto | SmsEstimateDto) {
    validateMessage(d.message, this.config.suffix());
    if ('name' in d && !d.name.trim())
      smsError('SMS_INVALID_NAME', 'Saisissez un nom de campagne.');
  }
  status(actor: string) {
    return this.repository.transaction(async (m) => {
      const user = await this.repository.actor(m, actor, 'sms.read');
      const suffix = this.config.suffix();
      return {
        enabled: this.config.enabled,
        provider: 'mobishastra',
        configured: this.transport.configured(),
        senderId: this.config.sender,
        credits: { balance: null, checkedAt: null },
        sendingWindow: this.config.window,
        frequencyCapDays: this.config.frequencyDays,
        maxRecipientsPerCampaign: this.config.maxRecipients,
        maxSegments: 1,
        optOut: { suffixExample: suffix, suffixLength: suffix.length },
        placeholders: [
          { key: 'prenom', label: 'Prénom', example: 'Jean', maxLength: 20 },
        ],
        permissions: permissions(user.role),
        testPhone: maskPhone(user.phone),
      };
    });
  }
  estimate(actor: string, dto: SmsEstimateDto) {
    this.config.assertEnabled();
    this.validate(dto);
    return this.repository.transaction(async (m) => {
      await this.repository.actor(m, actor, 'sms.write');
      await m.query("SET LOCAL statement_timeout='3s'");
      return this.audience.estimate(m, dto.audience, dto.message);
    });
  }
  create(actor: string, dto: SmsCreateDto) {
    this.config.assertEnabled();
    this.validate(dto);
    return this.repository.transaction(async (m) => {
      await this.repository.actor(m, actor, 'sms.write');
      return this.createIn(m, actor, dto);
    });
  }
  private async createIn(m: EntityManager, actor: string, dto: SmsCreateDto) {
    const key = `create:${actor}:${dto.requestId}`;
    const body = {
      name: dto.name.trim(),
      message: dto.message,
      audience: dto.audience,
    };
    await m.query(
      `INSERT INTO sms_campaigns(name,message,audience,"createdById","requestKey") VALUES($1,$2,$3,$4,$5)
      ON CONFLICT("requestKey") DO NOTHING`,
      [body.name, body.message, JSON.stringify(body.audience), actor, key],
    );
    const [c] = await m.query(
      'SELECT id FROM sms_campaigns WHERE "requestKey"=$1 FOR UPDATE',
      [key],
    );
    if (!(await this.repository.intent(m, key, c.id, body))) {
      const estimate = await this.audience.estimate(
        m,
        dto.audience,
        dto.message,
      );
      await m.query('UPDATE sms_campaigns SET estimate=$2 WHERE id=$1', [
        c.id,
        JSON.stringify(estimate),
      ]);
      await this.repository.audit(m, actor, 'create', c.id);
    }
    return this.repository.view(m, c.id);
  }
  update(actor: string, id: string, dto: SmsUpdateDto) {
    this.config.assertEnabled();
    this.validate(dto);
    return this.repository.transaction(async (m) => {
      await this.repository.actor(m, actor, 'sms.write');
      const c = await this.repository.lock(m, id, dto.revision);
      if (c.status !== 'draft')
        smsError(
          'SMS_INVALID_STATE',
          'Seul un brouillon peut être modifié.',
          409,
        );
      const estimate = await this.audience.estimate(
        m,
        dto.audience,
        dto.message,
      );
      await m.query(
        `UPDATE sms_campaigns SET name=$2,message=$3,audience=$4,revision=revision+1,
        "testRevision"=NULL,"testSentAt"=NULL,estimate=$5,"updatedAt"=now() WHERE id=$1`,
        [
          id,
          dto.name.trim(),
          dto.message,
          JSON.stringify(dto.audience),
          JSON.stringify(estimate),
        ],
      );
      await this.repository.audit(m, actor, 'update', id, {
        revision: dto.revision + 1,
      });
      return this.repository.view(m, id);
    });
  }
  get(actor: string, id: string) {
    return this.repository.transaction(async (m) => {
      await this.repository.actor(m, actor, 'sms.read');
      return this.repository.view(m, id);
    });
  }
  list(actor: string, page: SmsPageDto) {
    return this.repository.transaction(async (m) => {
      await this.repository.actor(m, actor, 'sms.read');
      const [count] = await m.query(
        'SELECT count(*)::int total FROM sms_campaigns WHERE ($1::text IS NULL OR status=$1)',
        [page.status ?? null],
      );
      const ids = await m.query(
        'SELECT id FROM sms_campaigns WHERE ($1::text IS NULL OR status=$1) ORDER BY "createdAt" DESC,id DESC LIMIT $2 OFFSET $3',
        [page.status ?? null, page.limit, (page.page - 1) * page.limit],
      );
      const items = await this.repository.views(
        m,
        ids.map((r) => r.id),
      );
      return { items, total: count.total, page: page.page, limit: page.limit };
    });
  }
  recipients(actor: string, id: string, page: SmsPageDto) {
    return this.repository.transaction(async (m) => {
      await this.repository.actor(m, actor, 'sms.read');
      return this.repository.recipients(m, id, page);
    });
  }
  duplicate(actor: string, id: string, requestId: string) {
    this.config.assertEnabled();
    return this.repository.transaction(async (m) => {
      await this.repository.actor(m, actor, 'sms.write');
      const c = await this.repository.lock(m, id);
      return this.createIn(m, actor, {
        name: c.name.slice(0, 72) + ' (copie)',
        message: c.message,
        audience: c.audience,
        requestId,
      });
    });
  }
  launch(actor: string, id: string, dto: SmsLaunchDto) {
    this.assertConfigured();
    return this.repository.transaction(async (m) => {
      await this.repository.actor(m, actor, 'sms.send');
      const c = await this.repository.lock(m, id);
      if (
        await this.repository.intent(
          m,
          `launch:${actor}:${dto.requestId}`,
          id,
          dto,
        )
      )
        return this.repository.view(m, id);
      if (c.revision !== dto.revision)
        smsError(
          'SMS_REVISION_CONFLICT',
          'La campagne a changé. Actualisez la page.',
          409,
        );
      if (c.status !== 'draft')
        smsError('SMS_INVALID_STATE', 'Cette campagne a déjà été lancée.', 409);
      this.validate(c);
      if (!c.testSentAt || c.testRevision !== c.revision)
        smsError(
          'SMS_TEST_REQUIRED',
          'Envoyez-vous un SMS de test de cette révision avant le lancement.',
          409,
        );
      const scheduled = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
      const delta = scheduled ? scheduled.getTime() - Date.now() : 0;
      if (
        scheduled &&
        (!Number.isFinite(delta) || delta < 300000 || delta > 30 * 86400000)
      )
        smsError(
          'SMS_INVALID_SCHEDULE',
          'Choisissez une date entre cinq minutes et trente jours dans le futur.',
        );
      const estimate = await this.audience.estimate(m, c.audience, c.message);
      this.checkSize(estimate.recipients);
      if (
        Math.abs(estimate.recipients - dto.expectedRecipients) >
        Math.max(10, dto.expectedRecipients * 0.1)
      )
        smsError(
          'SMS_AUDIENCE_CHANGED',
          `L’audience a changé : ${estimate.recipients} personnes au lieu de ${dto.expectedRecipients}. Vérifiez avant d’envoyer.`,
          409,
        );
      if (!scheduled) await this.audience.freeze(m, id, c.audience, c.message);
      await m.query(
        `UPDATE sms_campaigns SET status=$2,"scheduledAt"=$3,"startedAt"=CASE WHEN $3::timestamptz IS NULL THEN now() ELSE NULL END,
        "launchedById"=$4,"expectedRecipients"=$5,estimate=$6,revision=revision+1,"updatedAt"=now() WHERE id=$1`,
        [
          id,
          scheduled ? 'scheduled' : 'sending',
          scheduled,
          actor,
          estimate.recipients,
          JSON.stringify(estimate),
        ],
      );
      await this.repository.audit(m, actor, 'launch', id, {
        recipients: estimate.recipients,
        scheduled: !!scheduled,
      });
      return this.repository.view(m, id);
    }, 'REPEATABLE READ');
  }
  checkSize(n: number) {
    if (n > this.config.maxRecipients)
      smsError(
        'SMS_AUDIENCE_TOO_LARGE',
        'L’audience dépasse le maximum autorisé.',
      );
  }
  cancel(actor: string, id: string, revision: number) {
    this.config.assertEnabled();
    return this.repository.transaction(async (m) => {
      await this.repository.actor(m, actor, 'sms.send');
      const c = await this.repository.lock(m, id, revision);
      if (!['scheduled', 'sending', 'paused'].includes(c.status))
        smsError(
          'SMS_INVALID_STATE',
          'Cette campagne ne peut plus être annulée.',
          409,
        );
      await m.query(
        `UPDATE sms_campaigns SET status='cancelled',"cancelledAt"=now(),revision=revision+1,"updatedAt"=now() WHERE id=$1`,
        [id],
      );
      await m.query(
        `UPDATE sms_campaign_recipients SET status='skipped',"errorCode"='CAMPAIGN_CANCELLED' WHERE "campaignId"=$1 AND status='queued'`,
        [id],
      );
      await this.repository.audit(m, actor, 'cancel', id);
      return this.repository.view(m, id);
    });
  }
  resume(actor: string, id: string, revision: number) {
    this.assertConfigured();
    return this.repository.transaction(async (m) => {
      await this.repository.actor(m, actor, 'sms.send');
      const c = await this.repository.lock(m, id, revision);
      if (c.status !== 'paused')
        smsError(
          'SMS_INVALID_STATE',
          'Cette campagne n’est pas en pause.',
          409,
        );
      // A fresh confirmed test after a provider incident is evidence of recovery.
      const [test] = await m.query(
        `SELECT id FROM sms_test_sends WHERE "campaignId"=$1 AND status='sent' AND "createdAt">$2 LIMIT 1`,
        [id, c.updatedAt],
      );
      if (!test)
        smsError(
          'SMS_TEST_REQUIRED',
          'Effectuez un nouveau test réussi après la pause avant de reprendre.',
          409,
        );
      if (!c.startedAt) {
        const estimate = await this.audience.estimate(m, c.audience, c.message);
        this.checkSize(estimate.recipients);
      }
      await m.query(
        'UPDATE sms_runtime SET "pauseReason"=NULL,failures=0 WHERE id=1',
      );
      await m.query(
        `UPDATE sms_campaigns SET status=CASE WHEN "startedAt" IS NULL THEN 'scheduled' ELSE 'sending' END,
        "pauseReason"=NULL,"launchedById"=$2,revision=revision+1,"updatedAt"=now() WHERE id=$1`,
        [id, actor],
      );
      await this.repository.audit(m, actor, 'resume', id);
      return this.repository.view(m, id);
    });
  }
}
