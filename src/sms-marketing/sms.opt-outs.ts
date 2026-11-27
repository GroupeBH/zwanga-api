import { Injectable } from '@nestjs/common';
import { SmsRepository } from './sms.repository';
import { SmsOptOutDto, SmsPageDto } from './sms.dto';
import { maskPhone, smsError } from './sms.policy';

@Injectable()
export class SmsOptOutsService {
  constructor(readonly repository: SmsRepository) {}
  list(actor: string, page: SmsPageDto) {
    return this.repository.transaction(async (m) => {
      await this.repository.actor(m, actor, 'sms.read');
      const search = page.search
        ? `%${page.search.replace(/[\\%_]/g, '\\$&')}%`
        : null;
      const where = `o."removedAt" IS NULL AND ($1::text IS NULL OR o.phone ILIKE $1 OR concat_ws(' ',u."firstName",u."lastName") ILIKE $1)`;
      const [count] = await m.query(
        `SELECT count(*)::int total FROM sms_opt_outs o LEFT JOIN users u ON u.id=o."userId" WHERE ${where}`,
        [search],
      );
      const items = await m.query(
        `SELECT o.id,o.phone,concat_ws(' ',u."firstName",u."lastName") name,o.source,o.reason,o."createdAt",
      c.name "campaignName",CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id',a.id,'name',concat_ws(' ',a."firstName",a."lastName")) END "createdBy"
      FROM sms_opt_outs o LEFT JOIN users u ON u.id=o."userId" LEFT JOIN users a ON a.id=o."createdById"
      LEFT JOIN sms_campaigns c ON c.id=o."campaignId" WHERE ${where} ORDER BY o."createdAt" DESC,o.id LIMIT $2 OFFSET $3`,
        [search, page.limit, (page.page - 1) * page.limit],
      );
      return {
        items: items.map((r) => ({ ...r, phone: maskPhone(r.phone) })),
        total: count.total,
        page: page.page,
        limit: page.limit,
      };
    });
  }
  add(actor: string, dto: SmsOptOutDto) {
    this.repository.config.assertEnabled();
    if (!dto.reason.trim())
      smsError('SMS_REASON_REQUIRED', 'Indiquez le motif.');
    return this.repository.transaction(async (m) => {
      await this.repository.actor(m, actor, 'sms.optouts.manage');
      const [target] = await m.query(
        'SELECT id,"firstName","lastName" FROM users WHERE zwanga_canonical_phone(phone)=$1',
        [dto.phone],
      );
      const inserted = await m.query(
        `INSERT INTO sms_opt_outs(phone,"userId",source,reason,"createdById") VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(phone) WHERE "removedAt" IS NULL DO NOTHING RETURNING id`,
        [dto.phone, target?.id ?? null, dto.source, dto.reason.trim(), actor],
      );
      const [row] = await m.query(
        `SELECT o.id,o.phone,o.source,o.reason,o."createdAt",c.name "campaignName",
        CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id',a.id,'name',concat_ws(' ',a."firstName",a."lastName")) END "createdBy"
        FROM sms_opt_outs o LEFT JOIN users a ON a.id=o."createdById" LEFT JOIN sms_campaigns c ON c.id=o."campaignId"
        WHERE o.phone=$1 AND o."removedAt" IS NULL`,
        [dto.phone],
      );
      if (inserted.length)
        await this.repository.audit(m, actor, 'opt_out', null, {
          optOutId: row.id,
          source: dto.source,
        });
      return {
        ...row,
        phone: maskPhone(row.phone),
        name: target ? `${target.firstName} ${target.lastName}` : null,
      };
    });
  }
  remove(actor: string, id: string, reason: string) {
    this.repository.config.assertEnabled();
    if (!reason.trim())
      smsError(
        'SMS_REASON_REQUIRED',
        'Indiquez la demande de réinscription de la personne.',
      );
    return this.repository.transaction(async (m) => {
      await this.repository.actor(m, actor, 'sms.optouts.manage');
      const rows = await m.query(
        `UPDATE sms_opt_outs SET "removedAt"=now(),"removedById"=$2,"removedReason"=$3
        WHERE id=$1 AND "removedAt" IS NULL RETURNING id`,
        [id, actor, reason.trim()],
      );
      if (rows[0])
        await this.repository.audit(m, actor, 'opt_in', null, { optOutId: id });
    });
  }
  async publicPage(code: string, confirm: boolean): Promise<string> {
    let isTest = false;
    if (/^[0-9A-Za-z]{8}$/.test(code))
      await this.repository.transaction(async (m) => {
        const [test] = await m.query(
          `SELECT id FROM sms_test_sends WHERE code=$1 AND "createdAt">now()-interval '12 months'`,
          [code],
        );
        isTest = !!test;
        if (confirm && !test) {
          const [r] = await m.query(
            `SELECT id,phone,"userId","campaignId" FROM sms_campaign_recipients WHERE "optOutCode"=$1 AND "codeExpiresAt">now()`,
            [code],
          );
          if (r) {
            const inserted = await m.query(
              `INSERT INTO sms_opt_outs(phone,"userId",source,"campaignId") VALUES($1,$2,'link',$3)
            ON CONFLICT(phone) WHERE "removedAt" IS NULL DO NOTHING RETURNING id`,
              [r.phone, r.userId, r.campaignId],
            );
            if (inserted.length)
              await this.repository.audit(
                m,
                null,
                'link_opt_out',
                r.campaignId,
                { optOutId: inserted[0].id },
              );
          }
        }
      });
    // Identical status and content for valid/invalid/expired production codes.
    const title = isTest
      ? 'Lien de test : aucune désinscription enregistrée.'
      : confirm
        ? 'Votre demande a été prise en compte si le lien est encore valide.'
        : 'Ne plus recevoir les SMS promotionnels de Zwanga ?';
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SMS Zwanga</title></head><body><main><h1>${title}</h1><p>Votre compte, vos OTP et vos alertes de trajet restent inchangés.</p>${confirm ? '' : '<form method="post"><button type="submit">Ne plus recevoir les SMS promotionnels</button></form>'}</main></body></html>`;
  }
}
