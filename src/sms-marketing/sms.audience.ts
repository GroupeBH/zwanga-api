import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SmsAudienceDto } from './sms.dto';
import { SmsMarketingConfig } from './sms.config';
import { smsError } from './sms.policy';

// One SQL snapshot, no phone/name leaves PostgreSQL for estimates. Role is the
// canonical users.role protected by CHK_users_role_is_driver_consistency.
const AUDIENCE = `WITH p AS NOT MATERIALIZED (SELECT $1::jsonb a, $2::text message, $3::text suffix, $4::int days),
 input AS (SELECT value phone, row_number() OVER(PARTITION BY value) n FROM p,
   jsonb_array_elements_text(COALESCE(NULLIF(a->'phones','null'::jsonb),'[]'::jsonb))),
 candidates AS MATERIALIZED (SELECT u.id,u.phone,u."firstName",u."deletedAt",u."isActive",u.status,u."isPhoneVerified",
   zwanga_canonical_phone(u.phone) canonical FROM users u CROSS JOIN p
  WHERE u.role IN ('driver','passenger') AND (
    (a->'phones' IS NOT NULL AND a->'phones'<>'null'::jsonb AND EXISTS(SELECT 1 FROM input i WHERE i.phone=zwanga_canonical_phone(u.phone))) OR
    ((a->'phones' IS NULL OR a->'phones'='null'::jsonb)
      AND (jsonb_array_length(a->'roles')=0 OR a->'roles' ? u.role::text)
      AND (a->>'activeWithinDays' IS NULL OR u."lastLoginAt">=now()-(a->>'activeWithinDays')::int*interval '1 day')
      AND (a->>'inactiveForDays' IS NULL OR u."lastLoginAt" IS NULL OR u."lastLoginAt"<now()-(a->>'inactiveForDays')::int*interval '1 day')
      AND (a->>'signedUpFrom' IS NULL OR u."createdAt">=(a->>'signedUpFrom')::date::timestamp AT TIME ZONE 'Africa/Kinshasa')
      AND (a->>'signedUpTo' IS NULL OR u."createdAt"<((a->>'signedUpTo')::date+1)::timestamp AT TIME ZONE 'Africa/Kinshasa')
      AND (a->>'trips'='any' OR (a->>'trips'='atLeastOne')=(
        EXISTS(SELECT 1 FROM trips t WHERE t."driverId"=u.id AND t.status='completed') OR
        EXISTS(SELECT 1 FROM bookings b JOIN trips t ON t.id=b."tripId" WHERE b."passengerId"=u.id AND b.status='completed' AND t.status='completed')))
      AND (a->>'proSubscription'='any' OR (u.role='driver' AND (a->>'proSubscription'='active')=
        EXISTS(SELECT 1 FROM subscriptions s WHERE s."userId"=u.id AND s.status='active' AND s."startDate"<=now() AND s."endDate">now())))
      AND (a->>'kyc'='any' OR a->>'kyc'=(SELECT k.status::text FROM kyc_documents k WHERE k."userId"=u.id ORDER BY k."createdAt" DESC,k.id DESC LIMIT 1))
    )
  )), classified AS (SELECT u.id,u.canonical phone,
    CASE WHEN strpos(lower(p.message),'{prenom}')>0 THEN sms_render(p.message,u."firstName",p.suffix)
      ELSE sms_render(p.message,NULL,p.suffix) END rendered,
    CASE WHEN u."deletedAt" IS NOT NULL OR NOT u."isActive" OR u.status IN ('inactive','suspended') THEN 'inactiveAccount'
      WHEN u.phone IS NULL OR btrim(u.phone)='' THEN 'noPhone'
      WHEN u.canonical IS NULL OR u.canonical !~ '^\\+[1-9][0-9]{6,14}$' THEN 'invalidPhone'
      WHEN COALESCE((a->>'phoneVerifiedOnly')::boolean,true) AND NOT u."isPhoneVerified" THEN 'unverifiedPhone'
      WHEN EXISTS(SELECT 1 FROM sms_opt_outs o WHERE o.phone=u.canonical AND o."removedAt" IS NULL) THEN 'optedOut'
      WHEN EXISTS(SELECT 1 FROM sms_campaign_recipients r WHERE r.phone=u.canonical AND r.status IN ('sent','delivered') AND r."sentAt">now()-p.days*interval '1 day') THEN 'frequencyCap'
      ELSE NULL END reason
    FROM candidates u CROSS JOIN p), ranked AS (
      SELECT *,row_number() OVER(PARTITION BY phone ORDER BY id) rank FROM classified WHERE reason IS NULL
    ), eligible AS (SELECT * FROM ranked WHERE rank=1)`;

@Injectable()
export class SmsAudienceService {
  constructor(private readonly config: SmsMarketingConfig) {}
  args(audience: SmsAudienceDto, message: string) {
    if (
      audience.signedUpFrom &&
      audience.signedUpTo &&
      audience.signedUpFrom > audience.signedUpTo
    )
      smsError(
        'SMS_INVALID_AUDIENCE',
        'La date de début doit précéder la date de fin.',
      );
    return [
      JSON.stringify({ ...new SmsAudienceDto(), ...audience }),
      message,
      this.config.suffix(),
      this.config.frequencyDays,
    ];
  }
  async estimate(m: EntityManager, audience: SmsAudienceDto, message: string) {
    const [row] = await m.query(
      `${AUDIENCE}
      SELECT (SELECT count(*)::int FROM eligible) recipients,
      COALESCE((SELECT sum(n*sms_segments(rendered))::int FROM (SELECT rendered,count(*) n FROM eligible GROUP BY rendered) texts),0) segments,
      (SELECT coalesce(jsonb_object_agg(reason,n),'{}') FROM
        (SELECT reason,count(*)::int n FROM classified WHERE reason IS NOT NULL GROUP BY reason) x) excluded,
      (SELECT count(*)::int FROM input WHERE n>1)+(SELECT count(*)::int FROM ranked WHERE rank>1) duplicates,
      (SELECT count(*)::int FROM input i WHERE n=1 AND NOT EXISTS(
        SELECT 1 FROM users u WHERE zwanga_canonical_phone(u.phone)=i.phone)) unknown,
      now() "computedAt"`,
      this.args(audience, message),
    );
    return {
      recipients: row.recipients,
      segments: row.segments,
      credits: row.segments * this.config.credits,
      excluded: {
        inactiveAccount: 0,
        noPhone: 0,
        invalidPhone: 0,
        unverifiedPhone: 0,
        optedOut: 0,
        frequencyCap: 0,
        ...row.excluded,
        duplicates: row.duplicates,
        unknownPhones: row.unknown,
      },
      computedAt: row.computedAt,
    };
  }
  async freeze(
    m: EntityManager,
    id: string,
    audience: SmsAudienceDto,
    message: string,
  ) {
    await m.query(
      `${AUDIENCE}, costs AS MATERIALIZED (SELECT rendered,sms_segments(rendered) segments FROM (SELECT DISTINCT rendered FROM eligible) texts),
      frozen AS MATERIALIZED (SELECT e.*,c.segments,sms_new_code() code FROM eligible e JOIN costs c USING(rendered))
      INSERT INTO sms_campaign_recipients ("campaignId","userId",phone,"renderedText",segments,"optOutCode")
      SELECT $5::uuid,id,phone,left(rendered,length(rendered)-8)||code,segments,code FROM frozen`,
      [...this.args(audience, message), id],
    );
  }
}
