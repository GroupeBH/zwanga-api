import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Existing accounts and financial history are NEVER rewritten or merged. */
export class CanonicalPhoneIdentity1780000119000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await this.bounded(runner, async () => {
      // Block writes only during the bounded snapshot + trigger installation.
      await runner.query('LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE');
      await runner.query(`CREATE FUNCTION public.zwanga_canonical_phone(input text)
        RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
        DECLARE digits text;
        BEGIN
          -- Exactly JavaScript's whitespace set, independent of database locale.
          digits := translate(input,
            chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
            chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||
            chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||
            chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279)||'().-', '');
          IF left(digits,1) = '+' THEN digits := substring(digits FROM 2);
          ELSIF left(digits,2) = '00' THEN digits := substring(digits FROM 3);
          ELSIF left(digits,1) = '0' THEN digits := '243' || substring(digits FROM 2);
          ELSIF left(digits,3) <> '243' AND digits ~ '^[0-9]{8,10}$' THEN digits := '243' || digits;
          END IF;
          IF digits !~ '^[1-9][0-9]{6,14}$' THEN RETURN NULL; END IF;
          RETURN '+' || digits;
        END $fn$`);
      await runner.query(`CREATE INDEX "IDX_users_phone_identity"
        ON public.users (public.zwanga_canonical_phone(phone))`);
      // A NULL owner deliberately reserves an already ambiguous identity. It is
      // not silently assigned to the oldest/newest/active account.
      await runner.query(`CREATE TABLE public.user_phone_identities (
        phone text PRIMARY KEY,
        "userId" uuid UNIQUE,
        CHECK (public.zwanga_canonical_phone(phone) IS NOT NULL AND phone = public.zwanga_canonical_phone(phone))
      )`);
      await runner.query(`INSERT INTO public.user_phone_identities(phone,"userId")
        SELECT public.zwanga_canonical_phone(phone),
          CASE WHEN count(*)=1 THEN min(id::text)::uuid ELSE NULL END
        FROM public.users WHERE public.zwanga_canonical_phone(phone) IS NOT NULL
        GROUP BY public.zwanga_canonical_phone(phone)`);
      await runner.query(`CREATE FUNCTION public.zwanga_guard_phone_identity()
        RETURNS trigger LANGUAGE plpgsql AS $fn$
        DECLARE canonical text; claimed uuid;
        BEGIN
          IF TG_OP = 'DELETE' THEN
            DELETE FROM public.user_phone_identities WHERE "userId" = OLD.id;
            RETURN OLD;
          END IF;
          -- Routine saves of legacy users do not change their identifiers.
          IF TG_OP = 'UPDATE' AND NEW.phone IS NOT DISTINCT FROM OLD.phone THEN RETURN NEW; END IF;
          canonical := public.zwanga_canonical_phone(NEW.phone);
          IF NEW.phone IS NOT NULL AND canonical IS NULL THEN
            RAISE EXCEPTION 'Invalid phone identity' USING ERRCODE='23514', CONSTRAINT='CHK_users_phone_identity';
          END IF;
          -- Release only this user's own reservation, within the same transaction.
          -- Historical collisions (NULL owner) remain reserved for manual review.
          IF TG_OP = 'UPDATE' THEN
            DELETE FROM public.user_phone_identities
              WHERE "userId"=OLD.id AND phone IS DISTINCT FROM canonical;
          END IF;
          IF canonical IS NOT NULL THEN
            INSERT INTO public.user_phone_identities AS identity(phone,"userId") VALUES(canonical,NEW.id)
              ON CONFLICT (phone) DO UPDATE SET "userId"=EXCLUDED."userId"
              WHERE identity."userId"=EXCLUDED."userId"
              RETURNING "userId" INTO claimed;
            IF claimed IS NULL THEN
              RAISE EXCEPTION 'Phone identity unavailable' USING ERRCODE='23505', CONSTRAINT='UQ_users_phone_identity';
            END IF;
            NEW.phone := canonical;
          END IF;
          RETURN NEW;
        END $fn$`);
      await runner.query(`CREATE TRIGGER users_phone_identity_write
        BEFORE INSERT OR UPDATE OF phone ON public.users
        FOR EACH ROW EXECUTE FUNCTION public.zwanga_guard_phone_identity()`);
      await runner.query(`CREATE TRIGGER users_phone_identity_delete
        AFTER DELETE ON public.users
        FOR EACH ROW EXECUTE FUNCTION public.zwanga_guard_phone_identity()`);
    });
  }

  async down(runner: QueryRunner): Promise<void> {
    await this.bounded(runner, async () => {
      await runner.query(
        'DROP TRIGGER users_phone_identity_write ON public.users',
      );
      await runner.query(
        'DROP TRIGGER users_phone_identity_delete ON public.users',
      );
      await runner.query('DROP FUNCTION public.zwanga_guard_phone_identity()');
      await runner.query('DROP TABLE public.user_phone_identities');
      await runner.query('DROP INDEX public."IDX_users_phone_identity"');
      await runner.query('DROP FUNCTION public.zwanga_canonical_phone(text)');
    });
  }

  private async bounded(runner: QueryRunner, work: () => Promise<void>) {
    const own = !runner.isTransactionActive;
    if (own) await runner.startTransaction();
    try {
      const [old] =
        await runner.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
        current_setting('statement_timeout') AS statement_timeout`);
      await runner.query(
        "SELECT set_config('lock_timeout','3s',true), set_config('statement_timeout','30s',true)",
      );
      await work();
      await runner.query(
        "SELECT set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true)",
        [old.lock_timeout, old.statement_timeout],
      );
      if (own) await runner.commitTransaction();
    } catch (error) {
      if (own && runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    }
  }
}
