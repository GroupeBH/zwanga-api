import type { MigrationInterface, QueryRunner } from 'typeorm';
// Frozen migration constants: later policy edits must not alter deployed SQL.
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€\f';

export class SmsMarketing1780000149000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE sms_codes(code varchar(8) PRIMARY KEY);
    CREATE TABLE sms_campaigns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      name varchar(80) NOT NULL, message text NOT NULL, audience jsonb NOT NULL,
      status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','sending','paused','completed','cancelled','failed')),
      "pauseReason" text, "scheduledAt" timestamptz, "startedAt" timestamptz, "completedAt" timestamptz, "cancelledAt" timestamptz,
      "createdById" uuid REFERENCES users(id) ON DELETE SET NULL, "launchedById" uuid REFERENCES users(id) ON DELETE SET NULL,
      "testSentAt" timestamptz, "testRevision" integer, estimate jsonb, "expectedRecipients" integer,
      "requestKey" text NOT NULL UNIQUE, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX sms_campaigns_due ON sms_campaigns ("scheduledAt",id) WHERE status='scheduled';
    CREATE INDEX sms_campaigns_list ON sms_campaigns ("createdAt" DESC,id);
    CREATE TABLE sms_campaign_recipients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "campaignId" uuid NOT NULL REFERENCES sms_campaigns(id),
      "userId" uuid REFERENCES users(id) ON DELETE SET NULL, phone text NOT NULL,
      "renderedText" text NOT NULL, segments integer NOT NULL CHECK(segments BETWEEN 1 AND 4),
      "optOutCode" varchar(8) NOT NULL UNIQUE, "codeExpiresAt" timestamptz NOT NULL DEFAULT now()+interval '12 months',
      status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','delivered','failed','skipped')),
      "errorCode" text, "providerReference" text, "leaseId" uuid, "leaseUntil" timestamptz,
      "sentAt" timestamptz, "deliveredAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(),
      UNIQUE("campaignId",phone), UNIQUE("campaignId","userId")
    );
    CREATE INDEX sms_recipients_campaign_status ON sms_campaign_recipients ("campaignId",status,id);
    CREATE INDEX sms_recipients_claim ON sms_campaign_recipients ("campaignId","createdAt",id) WHERE status='queued';
    CREATE INDEX sms_recipients_frequency ON sms_campaign_recipients (phone,"sentAt" DESC) WHERE status IN ('sent','delivered');
    CREATE INDEX sms_recipients_leases ON sms_campaign_recipients ("leaseUntil") WHERE status='sending';
    CREATE TABLE sms_opt_outs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone text NOT NULL,
      "userId" uuid REFERENCES users(id) ON DELETE SET NULL,
      source text NOT NULL CHECK(source IN ('link','team','support')), reason varchar(200),
      "campaignId" uuid REFERENCES sms_campaigns(id), "createdById" uuid REFERENCES users(id) ON DELETE SET NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "removedAt" timestamptz,
      "removedById" uuid REFERENCES users(id) ON DELETE SET NULL, "removedReason" varchar(200)
    );
    CREATE UNIQUE INDEX sms_opt_outs_active_phone ON sms_opt_outs(phone) WHERE "removedAt" IS NULL;
    CREATE TABLE sms_audit (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "actorId" uuid REFERENCES users(id) ON DELETE SET NULL,
      action text NOT NULL, "campaignId" uuid REFERENCES sms_campaigns(id), detail jsonb NOT NULL DEFAULT '{}',
      "createdAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX sms_audit_campaign ON sms_audit("campaignId", "createdAt");
    CREATE TABLE sms_intents (
      key text PRIMARY KEY, "campaignId" uuid NOT NULL REFERENCES sms_campaigns(id), fingerprint text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE sms_test_sends (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "campaignId" uuid NOT NULL REFERENCES sms_campaigns(id),
      "actorId" uuid REFERENCES users(id) ON DELETE SET NULL, revision integer NOT NULL, "requestKey" text NOT NULL UNIQUE,
      code varchar(8) NOT NULL UNIQUE, status text NOT NULL CHECK(status IN ('sending','sent','failed')),
      "errorCode" text, "createdAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX sms_test_actor_rate ON sms_test_sends("actorId","createdAt");
    CREATE TABLE sms_runtime (
      id integer PRIMARY KEY CHECK(id=1), "nextSendAt" timestamptz NOT NULL DEFAULT now(),
      day date NOT NULL DEFAULT (now() AT TIME ZONE 'Africa/Kinshasa')::date,
      used integer NOT NULL DEFAULT 0, failures integer NOT NULL DEFAULT 0, "pauseReason" text
    );
    INSERT INTO sms_runtime(id) VALUES(1);`);
    const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
    await q.query(`CREATE FUNCTION sms_segments(value text) RETURNS integer LANGUAGE plpgsql IMMUTABLE STRICT AS $fn$
      DECLARE gsm integer; utf16 integer;
      BEGIN
        IF value='' THEN RETURN 0; END IF;
        IF translate(value,${quote(GSM_BASIC + GSM_EXTENDED)},'')<>'' THEN
          utf16:=length(value)+length(regexp_replace(value,U&'[^\\+010000-\\+10FFFF]','','g'));
          RETURN CASE WHEN utf16<=70 THEN 1 ELSE ceil(utf16/67.0)::int END;
        END IF;
        gsm:=2*length(value)-length(translate(value,${quote(GSM_EXTENDED)},''));
        RETURN CASE WHEN gsm=0 THEN 0 WHEN gsm<=160 THEN 1 ELSE ceil(gsm/153.0)::int END;
      END $fn$`);
    await q.query(String.raw`CREATE FUNCTION sms_first_name(name text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
      DECLARE c text; result text:=''; units integer:=0; width integer;
      BEGIN
        FOR c IN SELECT regexp_split_to_table(left(split_part(btrim(regexp_replace(coalesce(name,''),'\s+',' ','g')),' ',1),20),'') LOOP
          width:=CASE WHEN ascii(c)>65535 THEN 2 ELSE 1 END;
          EXIT WHEN units+width>20;
          result:=result||c; units:=units+width;
        END LOOP;
        RETURN result;
      END $fn$`);
    await q.query(String.raw`CREATE FUNCTION sms_render(message text, name text, suffix text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
      WITH n AS (SELECT sms_first_name(name) value)
      SELECT rtrim(regexp_replace(regexp_replace(message,
        CASE WHEN value='' THEN '\s*\{prenom\}' ELSE '\{prenom\}' END,
        replace(value,E'\\',E'\\\\'),'gi'),
        '\s+([,.;!?])','\1','g')) || suffix FROM n
      $fn$`);
    await q.query(`CREATE FUNCTION sms_new_code() RETURNS text LANGUAGE plpgsql VOLATILE AS $fn$
      DECLARE result text; b integer; claimed text;
      BEGIN LOOP
        result:='';
        WHILE length(result)<8 LOOP
          b:=get_byte(uuid_send(gen_random_uuid()),0);
          IF b<248 THEN result:=result || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',b%62+1,1); END IF;
        END LOOP;
        INSERT INTO sms_codes(code) VALUES(result) ON CONFLICT DO NOTHING RETURNING code INTO claimed;
        IF claimed IS NOT NULL THEN RETURN claimed; END IF;
      END LOOP; END $fn$`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE sms_runtime,sms_test_sends,sms_intents,sms_audit,sms_opt_outs,sms_campaign_recipients,sms_campaigns,sms_codes;
      DROP FUNCTION sms_new_code(); DROP FUNCTION sms_render(text,text,text); DROP FUNCTION sms_first_name(text); DROP FUNCTION sms_segments(text);`);
  }
}
