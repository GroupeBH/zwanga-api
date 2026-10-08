import { MigrationInterface, QueryRunner } from 'typeorm';

/** Booking writes also come from raw SQL (GPS, declarations, dispatch, cancellations).
 * The invariant therefore lives in PostgreSQL, in the SAME transaction as each write.
 * No network I/O; notifications use the existing transactional outbox.
 */
export class DriverCashCommissions1780000050000 implements MigrationInterface {
  name = 'DriverCashCommissions1780000050000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`SET LOCAL lock_timeout = '5s'`);
    await runner.query(`ALTER TABLE trips ADD COLUMN "acceptedPaymentModes" text[] NOT NULL DEFAULT ARRAY['electronic','points','cash'];
      ALTER TABLE recurring_trip_templates ADD COLUMN "acceptedPaymentModes" text[] NOT NULL DEFAULT ARRAY['electronic','points','cash'];
      ALTER TABLE trips ADD CONSTRAINT "CHK_trip_payment_modes" CHECK (cardinality("acceptedPaymentModes") > 0 AND "acceptedPaymentModes" <@ ARRAY['electronic','points','cash'] AND array_position("acceptedPaymentModes", NULL) IS NULL);
      ALTER TABLE recurring_trip_templates ADD CONSTRAINT "CHK_recurring_payment_modes" CHECK (cardinality("acceptedPaymentModes") > 0 AND "acceptedPaymentModes" <@ ARRAY['electronic','points','cash'] AND array_position("acceptedPaymentModes", NULL) IS NULL);
      ALTER TABLE bookings ADD COLUMN "cashCommissionPolicyVersion" smallint NOT NULL DEFAULT 1,
        ADD COLUMN "cashCommissionTokenValue" numeric(12,4) NOT NULL DEFAULT 100 CHECK ("cashCommissionTokenValue" > 0);
      UPDATE bookings SET "cashCommissionPolicyVersion" = 0 WHERE status IN ('accepted','completed','no_show','boarding_uncertain');
      ALTER TABLE wallet_accounts ADD COLUMN "reservedCashCommissionBalance" numeric(12,2) NOT NULL DEFAULT 0;
      ALTER TABLE wallet_accounts ADD CONSTRAINT "CHK_wallet_cash_reserve" CHECK ("reservedCashCommissionBalance" >= 0 AND "reservedCashCommissionBalance" <= "withdrawableBalance");
      ALTER TABLE wallet_ledger_entries DROP CONSTRAINT "CHK_wallet_ledger_type";
      ALTER TABLE wallet_ledger_entries ADD CONSTRAINT "CHK_wallet_ledger_type" CHECK (type IN ('top_up','loyalty_reward','booking_payment','booking_refund','booking_fare_adjustment','subscription_payment','subscription_reward','transfer_out','transfer_in','admin_adjustment','withdrawal','withdrawal_refund','cash_commission','cash_commission_refund'));
      CREATE TABLE cash_commissions (
        "bookingId" uuid PRIMARY KEY, "driverId" uuid NOT NULL REFERENCES users(id), "tripId" uuid NOT NULL,
        state text NOT NULL CHECK (state IN ('reserved','captured','released')),
        "baseAmount" numeric(12,2) NOT NULL DEFAULT 0, "commissionRate" numeric(4,3) NOT NULL DEFAULT 0.05 CHECK ("commissionRate" = 0.05),
        "commissionAmount" numeric(12,2) NOT NULL DEFAULT 0, "moneyPerToken" numeric(12,4) NOT NULL,
        "tokensDue" numeric(12,2) NOT NULL DEFAULT 0, "reservedTokens" numeric(12,2) NOT NULL DEFAULT 0,
        "chargedTokens" numeric(12,2) NOT NULL DEFAULT 0, "debtTokens" numeric(12,2) NOT NULL DEFAULT 0,
        revision integer NOT NULL DEFAULT 0, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CHECK ("baseAmount" >= 0 AND "commissionAmount" >= 0 AND "moneyPerToken" > 0 AND "tokensDue" >= 0 AND "reservedTokens" >= 0 AND "chargedTokens" >= 0 AND "debtTokens" >= 0),
        CHECK ((state = 'reserved' AND "chargedTokens" = 0 AND "tokensDue" = "reservedTokens" + "debtTokens") OR
          (state = 'captured' AND "reservedTokens" = 0 AND "tokensDue" = "chargedTokens" + "debtTokens") OR
          (state = 'released' AND "tokensDue" = 0 AND "reservedTokens" = 0 AND "chargedTokens" = 0 AND "debtTokens" = 0))
      );
      CREATE INDEX "IDX_cash_commissions_driver" ON cash_commissions ("driverId", "updatedAt" DESC, "bookingId");
      CREATE INDEX "IDX_cash_commissions_debt" ON cash_commissions ("driverId", "createdAt", "bookingId") WHERE "debtTokens" > 0;
      CREATE TABLE driver_pro_trial_claims (
        "userId" uuid PRIMARY KEY REFERENCES users(id), "identityKey" text UNIQUE,
        "startDate" timestamptz NOT NULL, "endDate" timestamptz NOT NULL, "subscriptionId" uuid,
        CHECK ("endDate" > "startDate")
      );`);

    await runner.query(`CREATE FUNCTION zwanga_finance_notice(k text, u uuid, t text, b text, d jsonb) RETURNS void LANGUAGE sql AS $$
      INSERT INTO notifications ("eventKey", "userId", "fcmToken", title, body, data, "isAutomatic", status, "errorMessage")
      VALUES (k, u, '', t, b, d, false, 'pending', NULL) ON CONFLICT ("eventKey") DO NOTHING;
    $$`);

    await runner.query(`CREATE FUNCTION zwanga_cash_sync(bid uuid, did uuid, tid uuid, base numeric, token_value numeric, target_state text, require_funds boolean) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE a wallet_accounts%ROWTYPE; c cash_commissions%ROWTYPE; previous cash_commissions%ROWTYPE;
      due numeric; available numeric; charge numeric := 0; reserve numeric := 0; ledger_id uuid; old_reserved numeric := 0;
    BEGIN
      IF base < 0 OR token_value <= 0 OR target_state NOT IN ('reserved','captured','released') THEN RAISE EXCEPTION 'CASH_INVALID_AMOUNT'; END IF;
      -- Acquire the FK key-share lock BEFORE the wallet: admin adjustments and
      -- withdrawals can already hold a stronger user lock while waiting for it.
      -- Credit reconciliation already holds this key-share through its ledger FK.
      PERFORM 1 FROM users WHERE id = did FOR KEY SHARE;
      INSERT INTO wallet_accounts ("userId", type, currency) VALUES (did, 'points', 'PTS') ON CONFLICT ("userId", type) DO NOTHING;
      -- Every path, including top-up debt reconciliation, locks wallet THEN commission.
      SELECT * INTO a FROM wallet_accounts WHERE "userId" = did AND type = 'points' FOR UPDATE;
      SELECT * INTO c FROM cash_commissions WHERE "bookingId" = bid FOR UPDATE;
      IF FOUND AND (c."driverId" <> did OR c."tripId" <> tid) THEN RAISE EXCEPTION 'CASH_OWNER_CHANGED'; END IF;
      IF c."bookingId" IS NULL THEN
        INSERT INTO cash_commissions ("bookingId","driverId","tripId",state,"moneyPerToken") VALUES (bid,did,tid,'released',token_value) RETURNING * INTO c;
      END IF;
      previous := c; old_reserved := c."reservedTokens";
      -- Freeze the conversion for this booking; a later configuration change cannot reprice its commission.
      due := CASE WHEN target_state = 'released' THEN 0 ELSE round(round(base * 0.05, 2) / c."moneyPerToken", 2) END;
      available := GREATEST(0, a."withdrawableBalance" - a."reservedCashCommissionBalance" + old_reserved);
      IF a."withdrawalsBlocked" THEN available := old_reserved; END IF;
      IF require_funds AND (a."withdrawalsBlocked" OR available + c."chargedTokens" < due OR EXISTS (SELECT 1 FROM cash_commissions WHERE "driverId" = did AND "bookingId" <> bid AND "debtTokens" > 0)) THEN
        RAISE EXCEPTION 'CASH_COMMISSION_INSUFFICIENT';
      END IF;
      IF target_state = 'reserved' THEN
        IF c."chargedTokens" > 0 THEN RAISE EXCEPTION 'CASH_STATE_CONFLICT'; END IF;
        reserve := LEAST(due, available);
        c."chargedTokens" := 0; c."debtTokens" := due - reserve;
      ELSE
        IF due >= c."chargedTokens" THEN charge := LEAST(due - c."chargedTokens", available);
        ELSE charge := due - c."chargedTokens"; END IF;
        c."chargedTokens" := c."chargedTokens" + charge;
        c."debtTokens" := due - c."chargedTokens";
      END IF;
      c.state := target_state; c."tokensDue" := due; c."reservedTokens" := reserve;
      c."baseAmount" := CASE WHEN target_state = 'released' THEN 0 ELSE base END;
      c."commissionAmount" := round(c."baseAmount" * 0.05, 2);
      IF ROW(c.state,c."tokensDue",c."reservedTokens",c."chargedTokens",c."debtTokens",c."baseAmount") IS NOT DISTINCT FROM
         ROW(previous.state,previous."tokensDue",previous."reservedTokens",previous."chargedTokens",previous."debtTokens",previous."baseAmount") THEN RETURN; END IF;
      UPDATE wallet_accounts SET balance = balance - charge, "withdrawableBalance" = "withdrawableBalance" - charge,
        "reservedCashCommissionBalance" = "reservedCashCommissionBalance" - old_reserved + reserve, "updatedAt" = now()
        WHERE id = a.id RETURNING * INTO a;
      UPDATE cash_commissions SET state = c.state, "tokensDue" = c."tokensDue", "reservedTokens" = c."reservedTokens",
        "chargedTokens" = c."chargedTokens", "debtTokens" = c."debtTokens", "baseAmount" = c."baseAmount",
        "commissionAmount" = c."commissionAmount", revision = revision + 1, "updatedAt" = now() WHERE "bookingId" = bid RETURNING * INTO c;
      IF charge <> 0 THEN
        ledger_id := uuid_generate_v4();
        INSERT INTO wallet_ledger_entries (id,"accountId","userId","accountType",type,amount,"withdrawableAmount","balanceAfter",currency,"relatedEntityType","relatedEntityId",description)
          VALUES (ledger_id,a.id,did,'points',CASE WHEN charge > 0 THEN 'cash_commission' ELSE 'cash_commission_refund' END,-charge,-charge,a.balance,a.currency,'cash_commission',bid,
          CASE WHEN charge > 0 THEN 'Commission Zwanga 5 % sur paiement cash' ELSE 'Régularisation de commission cash' END);
        PERFORM zwanga_finance_notice('cash-ledger:' || ledger_id,did,CASE WHEN charge > 0 THEN 'Commission cash prélevée' ELSE 'Commission cash régularisée' END,
          abs(charge)::text || ' jetons ' || CASE WHEN charge > 0 THEN 'prélevés pour votre commission cash.' ELSE 'recrédités sur votre portefeuille.' END,
          jsonb_build_object('type','wallet_' || CASE WHEN charge > 0 THEN 'cash_commission' ELSE 'cash_commission_refund' END,'bookingId',bid,'ledgerEntryId',ledger_id,'amount',-charge,'currency',a.currency));
      END IF;
      IF c."debtTokens" > previous."debtTokens" THEN
        PERFORM zwanga_finance_notice('cash-debt:' || bid || ':' || c.revision,did,'Recharge nécessaire',
          'Le montant final du trajet nécessite un complément de commission. Rechargez vos jetons pour accepter de nouvelles courses cash.',
          jsonb_build_object('type','cash_commission_debt','bookingId',bid,'debtTokens',c."debtTokens"));
      ELSIF a."withdrawableBalance" - a."reservedCashCommissionBalance" = 0 AND due > 0 AND previous."tokensDue" < due THEN
        PERFORM zwanga_finance_notice('cash-empty:' || bid || ':' || c.revision,did,'Réserve cash épuisée',
          'Rechargez vos jetons pour accepter de nouvelles courses cash. Les réservations déjà confirmées restent couvertes.',
          jsonb_build_object('type','cash_commission_low_balance','bookingId',bid));
      END IF;
    END $$`);

    await runner.query(`CREATE FUNCTION zwanga_cash_reconcile_credit() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE c cash_commissions%ROWTYPE;
    BEGIN
      IF NEW.amount <= 0 OR COALESCE(NEW."withdrawableAmount",0) <= 0 THEN RETURN NEW; END IF;
      PERFORM 1 FROM wallet_accounts WHERE id = NEW."accountId" FOR UPDATE;
      FOR c IN SELECT * FROM cash_commissions WHERE "driverId" = NEW."userId" AND "debtTokens" > 0 ORDER BY "createdAt", "bookingId" LOOP
        PERFORM zwanga_cash_sync(c."bookingId",c."driverId",c."tripId",c."baseAmount",c."moneyPerToken",c.state,false);
      END LOOP;
      RETURN NEW;
    END $$;
    CREATE TRIGGER wallet_cash_debt_credit AFTER INSERT ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION zwanga_cash_reconcile_credit();`);

    await runner.query(`CREATE FUNCTION zwanga_booking_cash_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE t trips%ROWTYPE; c cash_commissions%ROWTYPE; next_state text; require_funds boolean; validate_mode boolean;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        SELECT * INTO c FROM cash_commissions WHERE "bookingId" = OLD.id;
        IF FOUND AND c.state = 'reserved' THEN PERFORM zwanga_cash_sync(c."bookingId",c."driverId",c."tripId",0,c."moneyPerToken",'released',false); END IF;
        RETURN OLD;
      END IF;
      SELECT * INTO t FROM trips WHERE id = NEW."tripId";
      IF NOT FOUND THEN RETURN NEW; END IF;
      validate_mode := TG_OP = 'INSERT';
      IF TG_OP = 'UPDATE' THEN
        validate_mode := OLD."paymentMode" IS DISTINCT FROM NEW."paymentMode" OR (OLD.status = 'pending' AND NEW.status = 'accepted');
        IF OLD.status = 'completed' AND NEW.status IN ('pending','accepted') THEN RAISE EXCEPTION 'CASH_STATE_CONFLICT'; END IF;
        IF OLD."cashReceivedAt" IS NOT NULL AND OLD."paymentMode" IS DISTINCT FROM NEW."paymentMode" THEN RAISE EXCEPTION 'CASH_STATE_CONFLICT'; END IF;
      END IF;
      IF validate_mode AND COALESCE(NEW."paymentAmount",0) > 0 AND NOT (NEW."paymentMode" = ANY(t."acceptedPaymentModes")) THEN RAISE EXCEPTION 'TRIP_PAYMENT_MODE_UNAVAILABLE'; END IF;
      IF NEW."cashCommissionPolicyVersion" = 0 THEN RETURN NEW; END IF;
      SELECT * INTO c FROM cash_commissions WHERE "bookingId" = NEW.id;
      IF NEW."paymentMode" <> 'cash' OR NEW.status IN ('cancelled','rejected','expired','pending','no_show','boarding_uncertain') OR COALESCE(NEW."paymentAmount",0) <= 0 THEN
        IF c."bookingId" IS NOT NULL AND c.state <> 'released' THEN PERFORM zwanga_cash_sync(NEW.id,t."driverId",t.id,0,c."moneyPerToken",'released',false); END IF;
        RETURN NEW;
      END IF;
      IF NEW."paymentCurrency" <> 'CDF' THEN RAISE EXCEPTION 'CASH_CURRENCY_UNSUPPORTED'; END IF;
      next_state := CASE WHEN NEW.status = 'completed' THEN 'captured' ELSE 'reserved' END;
      -- Never strand a passenger because the measured final fare exceeds the estimate.
      -- Any uncovered adjustment is recorded as debt, settled by the next purchased credit.
      require_funds := c."bookingId" IS NULL OR c.state = 'released' OR
        (next_state = 'reserved' AND NOT COALESCE(NEW."pickedUp",false) AND round(round(NEW."paymentAmount" * 0.05,2) / c."moneyPerToken",2) > c."tokensDue");
      -- GPS can recover a previously accepted booking falsely classified as no-show.
      -- That is not a NEW election of cash; finish the ride and record any shortfall.
      IF TG_OP = 'UPDATE' AND c."bookingId" IS NOT NULL AND OLD.status IN ('no_show','boarding_uncertain')
        AND OLD."paymentMode" = 'cash' AND COALESCE(NEW."pickedUp",false) THEN require_funds := false; END IF;
      PERFORM zwanga_cash_sync(NEW.id,t."driverId",t.id,NEW."paymentAmount",NEW."cashCommissionTokenValue",next_state,require_funds);
      RETURN NEW;
    END $$;
    CREATE TRIGGER booking_cash_guard BEFORE INSERT OR DELETE OR UPDATE OF status,"paymentMode","paymentAmount","paymentCurrency","tripId" ON bookings FOR EACH ROW EXECUTE FUNCTION zwanga_booking_cash_guard();`);

    await runner.query(`CREATE FUNCTION zwanga_start_driver_trial(uid uuid, started timestamptz) RETURNS uuid LANGUAGE plpgsql AS $$
    DECLARE existing uuid; identity_key text; sid uuid := uuid_generate_v4(); claimed uuid;
    BEGIN
      SELECT CASE WHEN phone IS NOT NULL THEN encode(sha256(convert_to('zwanga-pro-trial:' || regexp_replace(phone,'[^0-9]','','g'),'UTF8')),'hex') END
        INTO identity_key FROM users WHERE id = uid;
      SELECT "subscriptionId" INTO existing FROM driver_pro_trial_claims WHERE "userId" = uid;
      IF FOUND THEN RETURN existing; END IF;
      INSERT INTO driver_pro_trial_claims ("userId","identityKey","startDate","endDate") VALUES (uid,identity_key,started,started + interval '30 days')
        ON CONFLICT DO NOTHING RETURNING "userId" INTO claimed;
      IF claimed IS NULL THEN RETURN NULL; END IF;
      -- Never replace an entitlement already purchased before the first completed ride.
      IF EXISTS (SELECT 1 FROM subscriptions WHERE "userId"::uuid = uid AND status = 'active' AND "endDate" > now()) THEN RETURN NULL; END IF;
      INSERT INTO subscriptions (id,"userId",plan,status,"startDate","endDate",amount,currency,"premiumBadgeEnabled","featuredTripsEnabled","documentFundingEnabled","documentFundingLimit","documentFundingCurrency","isTrial")
        VALUES (sid,uid,'pro',CASE WHEN started + interval '30 days' > now() THEN 'active'::subscriptions_status_enum ELSE 'expired'::subscriptions_status_enum END,
          started,started + interval '30 days',0,'CDF',true,true,false,0,'CDF',true);
      UPDATE driver_pro_trial_claims SET "subscriptionId" = sid WHERE "userId" = uid;
      IF started + interval '30 days' > now() THEN
        PERFORM zwanga_finance_notice('pro-trial:' || uid,uid,'Votre essai Pro est activé',
          'Vous bénéficiez de 30 jours calendaires de Pro. Les commissions de 5 % restent dues, y compris sur le cash.',
          jsonb_build_object('type','driver_pro_trial_started','subscriptionId',sid,'endDate',started + interval '30 days'));
      END IF;
      RETURN sid;
    END $$`);
    // Preserve historical trials and their original end dates. No retroactive extension.
    await runner.query(`INSERT INTO driver_pro_trial_claims ("userId","identityKey","startDate","endDate","subscriptionId")
      SELECT DISTINCT ON (s."userId") s."userId"::uuid,
        CASE WHEN u.phone IS NOT NULL THEN encode(sha256(convert_to('zwanga-pro-trial:' || regexp_replace(u.phone,'[^0-9]','','g'),'UTF8')),'hex') END,
        s."startDate",s."endDate",s.id FROM subscriptions s JOIN users u ON u.id = s."userId"::uuid
      WHERE s."isTrial" = true ORDER BY s."userId",s."startDate" ON CONFLICT DO NOTHING;
      CREATE FUNCTION zwanga_first_completed_trial() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE did uuid; started timestamptz;
      BEGIN
        IF NEW.status <> 'completed' OR (TG_OP = 'UPDATE' AND OLD.status = 'completed') THEN RETURN NEW; END IF;
        SELECT "driverId" INTO did FROM trips WHERE id = NEW."tripId";
        IF EXISTS (SELECT 1 FROM driver_pro_trial_claims WHERE "userId" = did) THEN RETURN NEW; END IF;
        SELECT MIN(COALESCE(b."droppedOffAt",b."createdAt")) INTO started FROM bookings b JOIN trips t ON t.id = b."tripId" WHERE t."driverId" = did AND b.status = 'completed';
        IF did IS NOT NULL THEN PERFORM zwanga_start_driver_trial(did,COALESCE(started,now())); END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER booking_first_completed_trial AFTER INSERT OR UPDATE OF status ON bookings FOR EACH ROW EXECUTE FUNCTION zwanga_first_completed_trial();`);
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error(
        'Driver cash commissions contain financial reservations and history. Use a forward migration after reconciliation; automatic rollback is unsafe.',
      ),
    );
  }
}
