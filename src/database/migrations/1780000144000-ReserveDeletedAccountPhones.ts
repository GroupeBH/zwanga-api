import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Retain only the canonical phone reservation after profile anonymization.
 * No FK: physical deletion must not erase the permanent reservation.
 * Already erased historical phone numbers cannot be reconstructed here.
 */
export class ReserveDeletedAccountPhones1780000144000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const own = !runner.isTransactionActive;
    if (own) await runner.startTransaction();
    try {
      const [old] =
        (await runner.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
        current_setting('statement_timeout') AS statement_timeout`)) as {
          lock_timeout: string;
          statement_timeout: string;
        }[];
      await runner.query(
        "SELECT set_config('lock_timeout','3s',true), set_config('statement_timeout','30s',true)",
      );
      // Same table order as normal writes; do not race the backfill and trigger replacement.
      await runner.query('LOCK TABLE public.users IN ACCESS EXCLUSIVE MODE');
      await runner.query(
        'ALTER TABLE public.users ADD COLUMN IF NOT EXISTS "deletedAt" timestamptz',
      );
      await runner.query(
        'ALTER TABLE public.user_phone_identities ADD COLUMN "deletedAt" timestamptz',
      );
      // Only the explicit legacy anonymization signature, never mere inactivity/suspension.
      await runner.query(`UPDATE public.users SET "deletedAt" = CURRENT_TIMESTAMP
        WHERE "deletedAt" IS NULL AND status = 'inactive' AND "isActive" = false
          AND "firstName" = 'Compte' AND "lastName" = 'supprimé'
          AND email IS NULL AND "googleId" IS NULL AND "appleId" IS NULL`);
      await runner.query(`UPDATE public.user_phone_identities p SET "deletedAt" = u."deletedAt", "userId" = NULL
        FROM public.users u WHERE u."deletedAt" IS NOT NULL AND
          (p."userId" = u.id OR p.phone = public.zwanga_canonical_phone(u.phone))`);
      await runner.query(`CREATE OR REPLACE FUNCTION public.zwanga_guard_phone_identity()
        RETURNS trigger LANGUAGE plpgsql AS $fn$
        DECLARE canonical text; claimed uuid; retired timestamptz; removed boolean;
        BEGIN
          IF TG_OP = 'DELETE' THEN
            canonical := public.zwanga_canonical_phone(OLD.phone);
            removed := true;
          ELSE
            IF TG_OP = 'UPDATE' THEN
              -- Accept deletion by older backend versions during a rolling deployment.
              IF OLD."deletedAt" IS NOT NULL THEN NEW."deletedAt" := OLD."deletedAt";
              ELSIF NEW.phone IS NULL AND NEW.status = 'inactive' AND NEW."isActive" = false
                AND NEW."firstName" = 'Compte' AND NEW."lastName" = 'supprimé'
                AND NEW.email IS NULL AND NEW."googleId" IS NULL AND NEW."appleId" IS NULL
                THEN NEW."deletedAt" := CURRENT_TIMESTAMP;
              END IF;
            END IF;
            removed := NEW."deletedAt" IS NOT NULL;
            canonical := public.zwanga_canonical_phone(NEW.phone);
            IF NEW.phone IS NOT NULL AND canonical IS NULL THEN
              RAISE EXCEPTION 'Invalid phone identity' USING ERRCODE='23514', CONSTRAINT='CHK_users_phone_identity';
            END IF;
          END IF;

          IF removed THEN
            IF TG_OP <> 'INSERT' THEN
              canonical := public.zwanga_canonical_phone(OLD.phone);
              UPDATE public.user_phone_identities SET "deletedAt" = COALESCE("deletedAt", CURRENT_TIMESTAMP), "userId" = NULL
                WHERE "userId" = OLD.id;
            END IF;
            IF canonical IS NOT NULL THEN
              INSERT INTO public.user_phone_identities AS identity(phone, "userId", "deletedAt")
                VALUES(canonical, NULL, CURRENT_TIMESTAMP)
                ON CONFLICT (phone) DO UPDATE SET "userId" = NULL,
                  "deletedAt" = COALESCE(identity."deletedAt", EXCLUDED."deletedAt");
            END IF;
            IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
            IF NEW.phone IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.phone IS DISTINCT FROM OLD.phone) THEN
              RAISE EXCEPTION 'Deleted phone identity' USING ERRCODE='23514', CONSTRAINT='CHK_users_deleted_phone';
            END IF;
            NEW."isActive" := false;
            NEW.status := 'inactive';
            RETURN NEW;
          END IF;

          IF TG_OP = 'UPDATE' AND NEW.phone IS NOT DISTINCT FROM OLD.phone THEN RETURN NEW; END IF;
          IF TG_OP = 'UPDATE' THEN
            DELETE FROM public.user_phone_identities
              WHERE "userId" = OLD.id AND phone IS DISTINCT FROM canonical AND "deletedAt" IS NULL;
          END IF;
          IF canonical IS NOT NULL THEN
            -- The unique index serializes claims against concurrent deletion. Never overwrite
            -- an existing owner or tombstone; RETURNING reads the row after conflict resolution.
            INSERT INTO public.user_phone_identities AS identity(phone, "userId") VALUES(canonical, NEW.id)
              ON CONFLICT (phone) DO UPDATE SET phone = identity.phone
              RETURNING "userId", "deletedAt" INTO claimed, retired;
            IF retired IS NOT NULL THEN
              RAISE EXCEPTION 'Deleted phone identity' USING ERRCODE='23514', CONSTRAINT='CHK_users_deleted_phone';
            END IF;
            IF claimed IS DISTINCT FROM NEW.id THEN
              RAISE EXCEPTION 'Phone identity unavailable' USING ERRCODE='23505', CONSTRAINT='UQ_users_phone_identity';
            END IF;
            NEW.phone := canonical;
          END IF;
          RETURN NEW;
        END $fn$`);
      await runner.query(
        'DROP TRIGGER users_phone_identity_write ON public.users',
      );
      await runner.query(`CREATE TRIGGER users_phone_identity_write
        BEFORE INSERT OR UPDATE OF phone, "deletedAt", "firstName", "lastName", status, "isActive"
        ON public.users FOR EACH ROW EXECUTE FUNCTION public.zwanga_guard_phone_identity()`);
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

  down(): Promise<void> {
    // An automatic rollback must never make deleted phone numbers available again.
    return Promise.reject(
      new Error(
        'Permanent deleted-phone reservations require an explicit retention review; automatic rollback is disabled.',
      ),
    );
  }
}
