import { MigrationInterface, QueryRunner } from 'typeorm';

/** Both ORM and raw SQL approval paths must obey the same financial invariant. */
export class AddVerifiedWelcomeBonus1780000052000 implements MigrationInterface {
  name = 'AddVerifiedWelcomeBonus1780000052000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`SET LOCAL lock_timeout = '5s'`);
    await runner.query(`
      CREATE TABLE welcome_bonus_grants (
        "userId" uuid PRIMARY KEY REFERENCES users(id),
        "kycDocumentId" uuid NOT NULL,
        "ledgerEntryId" uuid NOT NULL UNIQUE,
        amount numeric(12,2) NOT NULL DEFAULT 50 CHECK (amount = 50),
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      -- Keep the audit claim even if a document or wallet is later replaced.
      CREATE INDEX "IDX_kyc_welcome_latest" ON kyc_documents ("userId", "createdAt" DESC, id DESC);
      CREATE INDEX "IDX_users_welcome_eligible" ON users (id)
        WHERE "isActive" = true AND status = 'active' AND role IN ('passenger','driver');
      CREATE UNIQUE INDEX "UQ_wallet_welcome_bonus" ON wallet_ledger_entries ("userId")
        WHERE type = 'loyalty_reward' AND "relatedEntityType" = 'welcome_bonus';
    `);
    await runner.query(`
      CREATE FUNCTION zwanga_grant_welcome_bonus(uid uuid) RETURNS boolean LANGUAGE plpgsql AS $$
      DECLARE u users%ROWTYPE; k kyc_documents%ROWTYPE; a wallet_accounts%ROWTYPE;
        ledger_id uuid; credited numeric(12,2);
      BEGIN
        IF uid IS NULL OR EXISTS (SELECT 1 FROM welcome_bonus_grants WHERE "userId" = uid) THEN RETURN false; END IF;
        -- User, then wallet. NO KEY UPDATE serializes grants/status changes but
        -- remains compatible with the FK key-share lock of an ongoing top-up.
        SELECT * INTO u FROM users WHERE id = uid FOR NO KEY UPDATE;
        IF NOT FOUND OR NOT u."isActive" OR u.status <> 'active' OR u.role NOT IN ('passenger','driver') THEN RETURN false; END IF;
        IF EXISTS (SELECT 1 FROM welcome_bonus_grants WHERE "userId" = uid) THEN RETURN false; END IF;
        SELECT * INTO k FROM kyc_documents WHERE "userId" = uid ORDER BY "createdAt" DESC, id DESC LIMIT 1;
        IF NOT FOUND OR k.status <> 'approved' THEN RETURN false; END IF;

        -- Defensive recovery: a known welcome ledger entry is never credited again.
        SELECT id INTO ledger_id FROM wallet_ledger_entries WHERE "userId" = uid
          AND type = 'loyalty_reward' AND "relatedEntityType" = 'welcome_bonus';
        IF FOUND THEN
          INSERT INTO welcome_bonus_grants ("userId","kycDocumentId","ledgerEntryId") VALUES (uid,k.id,ledger_id);
          RETURN false;
        END IF;
        INSERT INTO wallet_accounts ("userId",type,currency) VALUES (uid,'points','PTS')
          ON CONFLICT ("userId",type) DO NOTHING;
        SELECT * INTO a FROM wallet_accounts WHERE "userId" = uid AND type = 'points' FOR UPDATE;
        IF a.currency <> 'PTS' THEN RAISE EXCEPTION 'WELCOME_BONUS_INVALID_WALLET_CURRENCY'; END IF;
        -- Promotional tokens: never increase purchased funds or cash commission reserves.
        UPDATE wallet_accounts SET balance = balance + 50, "updatedAt" = now()
          WHERE id = a.id RETURNING balance INTO credited;
        ledger_id := uuid_generate_v4();
        INSERT INTO wallet_ledger_entries
          (id,"accountId","userId","accountType",type,amount,"withdrawableAmount","balanceAfter",currency,"relatedEntityType","relatedEntityId",description)
          VALUES (ledger_id,a.id,uid,'points','loyalty_reward',50,0,credited,'PTS','welcome_bonus',uid,
            'Bonus de bienvenue : KYC et compte validés');
        INSERT INTO welcome_bonus_grants ("userId","kycDocumentId","ledgerEntryId") VALUES (uid,k.id,ledger_id);
        -- Raw SQL bypasses ORM subscribers, so enqueue explicitly, without network I/O.
        INSERT INTO notifications ("eventKey","userId","fcmToken",title,body,data,"isAutomatic",status,"errorMessage")
          VALUES ('wallet:' || ledger_id,uid,'','Bonus de bienvenue reçu',
            'Votre identité et votre compte sont validés. 50 jetons de bienvenue ont été ajoutés à votre portefeuille.',
            jsonb_build_object('type','wallet_loyalty_reward','ledgerEntryId',ledger_id,'amount',50,'currency','PTS',
              'balanceAfter',credited,'relatedEntityType','welcome_bonus','relatedEntityId',uid,'paymentTransactionId',NULL),
            false,'pending',NULL) ON CONFLICT ("eventKey") DO NOTHING;
        RETURN true;
      END $$;

      CREATE FUNCTION zwanga_welcome_bonus_on_validation() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE previous_timeout text := current_setting('lock_timeout');
      BEGIN
        -- Some approval paths already hold a stronger user lock. Do not strand
        -- KYC approval behind a concurrent wallet writer waiting for that FK.
        -- A subtransaction rolls back ONLY this bonus attempt on contention;
        -- the minute worker will recover the eligible, unclaimed account.
        PERFORM set_config('lock_timeout','250ms',true);
        BEGIN
          IF TG_TABLE_NAME = 'users' THEN PERFORM zwanga_grant_welcome_bonus(NEW.id);
          ELSE PERFORM zwanga_grant_welcome_bonus(NEW."userId"); END IF;
        EXCEPTION WHEN lock_not_available OR deadlock_detected THEN NULL;
        END;
        PERFORM set_config('lock_timeout',previous_timeout,true);
        RETURN NEW;
      END $$;
      -- Defer until commit: approving then rejecting/suspending in one transaction
      -- must not pay a bonus based on an intermediate state.
      CREATE CONSTRAINT TRIGGER users_verified_welcome_bonus AFTER INSERT OR UPDATE ON users
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        WHEN (NEW."isActive" = true AND NEW.status = 'active' AND NEW.role IN ('passenger','driver'))
        EXECUTE FUNCTION zwanga_welcome_bonus_on_validation();
      CREATE CONSTRAINT TRIGGER kyc_verified_welcome_bonus AFTER INSERT OR UPDATE ON kyc_documents
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'approved')
        EXECUTE FUNCTION zwanga_welcome_bonus_on_validation();
    `);
    await runner.query(`
      CREATE FUNCTION zwanga_backfill_welcome_bonus(batch_size integer DEFAULT 100) RETURNS integer LANGUAGE plpgsql AS $$
      DECLARE candidate uuid; credited integer := 0;
      BEGIN
        IF batch_size IS NULL OR batch_size < 1 OR batch_size > 100 THEN RAISE EXCEPTION 'WELCOME_BONUS_INVALID_BATCH_SIZE'; END IF;
        FOR candidate IN
          SELECT u.id FROM users u
          WHERE u."isActive" = true AND u.status = 'active' AND u.role IN ('passenger','driver')
            AND NOT EXISTS (SELECT 1 FROM welcome_bonus_grants g WHERE g."userId" = u.id)
            AND (SELECT k.status FROM kyc_documents k WHERE k."userId" = u.id ORDER BY k."createdAt" DESC, k.id DESC LIMIT 1) = 'approved'
          ORDER BY u.id LIMIT batch_size FOR NO KEY UPDATE OF u SKIP LOCKED
        LOOP
          IF zwanga_grant_welcome_bonus(candidate) THEN credited := credited + 1; END IF;
        END LOOP;
        RETURN credited;
      END $$;
    `);
    // Historical credits are intentionally NOT issued in the deployment transaction.
    // The bounded worker performs the resumable catch-up once the backend is running.
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error(
        'Welcome bonuses are financial history; use a reviewed forward migration, never silently undo credits.',
      ),
    );
  }
}
