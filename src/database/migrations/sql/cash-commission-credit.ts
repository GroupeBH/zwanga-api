// Immutable SQL for migration 1780000053000. Wallet-first serialization applies
// to bookings, dispatch selections, credit reconciliation and request releases.
export const cashCreditSyncSql = `
CREATE FUNCTION zwanga_cash_sync(bid uuid, did uuid, tid uuid, base numeric, token_value numeric, target_state text, require_funds boolean, credit_limit numeric) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a wallet_accounts%ROWTYPE; c cash_commissions%ROWTYPE; previous cash_commissions%ROWTYPE;
  due numeric; available numeric; charge numeric := 0; reserve numeric := 0; ledger_id uuid; old_reserved numeric := 0; other_debt numeric;
BEGIN
  IF base IS NULL OR base < 0 OR token_value IS NULL OR token_value <= 0 OR target_state NOT IN ('reserved','captured','released') THEN RAISE EXCEPTION 'CASH_INVALID_AMOUNT'; END IF;
  PERFORM 1 FROM users WHERE id = did FOR KEY SHARE;
  INSERT INTO wallet_accounts ("userId",type,currency) VALUES (did,'points','PTS') ON CONFLICT ("userId",type) DO NOTHING;
  SELECT * INTO a FROM wallet_accounts WHERE "userId" = did AND type = 'points' FOR UPDATE;
  SELECT * INTO c FROM cash_commissions WHERE "bookingId" = bid FOR UPDATE;
  IF FOUND AND (c."driverId" <> did OR c."tripId" <> tid) THEN RAISE EXCEPTION 'CASH_OWNER_CHANGED'; END IF;
  IF c."bookingId" IS NULL THEN
    INSERT INTO cash_commissions ("bookingId","driverId","tripId",state,"moneyPerToken","creditLimitTokens")
      VALUES (bid,did,tid,'released',token_value,COALESCE(credit_limit,0)) RETURNING * INTO c;
  END IF;
  previous := c; old_reserved := c."reservedTokens";
  due := CASE WHEN target_state = 'released' THEN 0 ELSE round(round(base * c."commissionRate",2) / c."moneyPerToken",2) END;
  available := GREATEST(0,a."withdrawableBalance" - a."reservedCashCommissionBalance" + old_reserved);
  IF a."withdrawalsBlocked" THEN available := old_reserved; END IF;
  SELECT COALESCE(SUM("debtTokens"),0) INTO other_debt FROM cash_commissions WHERE "driverId" = did AND "bookingId" <> bid AND "debtTokens" > 0;
  IF require_funds THEN
    IF a."withdrawalsBlocked" THEN RAISE EXCEPTION 'CASH_COMMISSION_INSUFFICIENT'; END IF;
    IF other_debt > 0 OR (c."debtTokens" > 0 AND due > c."tokensDue") THEN RAISE EXCEPTION 'CASH_DEBT_OUTSTANDING'; END IF;
    IF GREATEST(0,due - available - c."chargedTokens") > c."creditLimitTokens" THEN
      RAISE EXCEPTION 'CASH_COMMISSION_INSUFFICIENT';
    END IF;
  END IF;
  IF target_state = 'reserved' THEN
    IF c."chargedTokens" > 0 THEN RAISE EXCEPTION 'CASH_STATE_CONFLICT'; END IF;
    reserve := LEAST(due,available); c."chargedTokens" := 0; c."debtTokens" := due - reserve;
  ELSE
    IF due >= c."chargedTokens" THEN charge := LEAST(due - c."chargedTokens",available);
    ELSE charge := due - c."chargedTokens"; END IF;
    c."chargedTokens" := c."chargedTokens" + charge; c."debtTokens" := due - c."chargedTokens";
  END IF;
  c.state := target_state; c."tokensDue" := due; c."reservedTokens" := reserve;
  c."baseAmount" := CASE WHEN target_state = 'released' THEN 0 ELSE base END;
  c."commissionAmount" := round(c."baseAmount" * c."commissionRate",2);
  IF ROW(c.state,c."tokensDue",c."reservedTokens",c."chargedTokens",c."debtTokens",c."baseAmount") IS NOT DISTINCT FROM
     ROW(previous.state,previous."tokensDue",previous."reservedTokens",previous."chargedTokens",previous."debtTokens",previous."baseAmount") THEN RETURN; END IF;
  UPDATE wallet_accounts SET balance = balance - charge, "withdrawableBalance" = "withdrawableBalance" - charge,
    "reservedCashCommissionBalance" = "reservedCashCommissionBalance" - old_reserved + reserve, "updatedAt" = now() WHERE id = a.id RETURNING * INTO a;
  UPDATE cash_commissions SET state = c.state, "tokensDue" = c."tokensDue", "reservedTokens" = c."reservedTokens",
    "chargedTokens" = c."chargedTokens", "debtTokens" = c."debtTokens", "baseAmount" = c."baseAmount",
    "commissionAmount" = c."commissionAmount", revision = revision + 1, "updatedAt" = now() WHERE "bookingId" = bid RETURNING * INTO c;
  IF charge <> 0 THEN
    ledger_id := uuid_generate_v4();
    INSERT INTO wallet_ledger_entries (id,"accountId","userId","accountType",type,amount,"withdrawableAmount","balanceAfter",currency,"relatedEntityType","relatedEntityId",description)
      VALUES (ledger_id,a.id,did,'points',CASE WHEN charge > 0 THEN 'cash_commission' ELSE 'cash_commission_refund' END,-charge,-charge,a.balance,a.currency,'cash_commission',bid,
        CASE WHEN charge > 0 THEN 'Commission Zwanga ' || (c."commissionRate" * 100)::text || ' % sur paiement cash' ELSE 'Régularisation de commission cash' END);
    PERFORM zwanga_finance_notice('cash-ledger:' || ledger_id,did,CASE WHEN charge > 0 THEN 'Commission cash prélevée' ELSE 'Commission cash régularisée' END,
      abs(charge)::text || ' jetons ' || CASE WHEN charge > 0 THEN 'prélevés pour votre commission cash.' ELSE 'recrédités sur votre portefeuille.' END,
      jsonb_build_object('type','wallet_' || CASE WHEN charge > 0 THEN 'cash_commission' ELSE 'cash_commission_refund' END,'bookingId',bid,'ledgerEntryId',ledger_id,'amount',-charge,'currency',a.currency));
  END IF;
  IF c."debtTokens" > previous."debtTokens" THEN
    PERFORM zwanga_finance_notice('cash-debt:' || did || ':' || bid || ':' || c.revision,did,'Commission cash à régulariser',
      (other_debt + c."debtTokens")::text || ' jetons dus. Aucun nouveau paiement cash avant régularisation par recharge. Les courses confirmées peuvent se terminer.',
      jsonb_build_object('type','cash_commission_debt','bookingId',bid,'debtTokens',other_debt + c."debtTokens"));
  END IF;
END $$;

-- Existing reconciliation callers keep the rate frozen in the commission row.
CREATE OR REPLACE FUNCTION zwanga_cash_sync(bid uuid, did uuid, tid uuid, base numeric, token_value numeric, target_state text, require_funds boolean) RETURNS void LANGUAGE sql AS $$
  SELECT zwanga_cash_sync(bid,did,tid,base,token_value,target_state,require_funds,NULL::numeric);
$$;

CREATE FUNCTION zwanga_cash_check_capacity(did uuid, base numeric) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a wallet_accounts%ROWTYPE; due numeric;
BEGIN
  IF base <= 0 THEN RETURN; END IF;
  PERFORM 1 FROM users WHERE id = did FOR KEY SHARE;
  INSERT INTO wallet_accounts ("userId",type,currency) VALUES (did,'points','PTS') ON CONFLICT ("userId",type) DO NOTHING;
  SELECT * INTO a FROM wallet_accounts WHERE "userId" = did AND type = 'points' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cash_commissions WHERE "driverId" = did AND "debtTokens" > 0) THEN RAISE EXCEPTION 'CASH_DEBT_OUTSTANDING'; END IF;
  due := round(round(base * 0.05,2) / 100,2);
  IF a."withdrawalsBlocked" OR due > GREATEST(0,a."withdrawableBalance" - a."reservedCashCommissionBalance") + 25 THEN RAISE EXCEPTION 'CASH_COMMISSION_INSUFFICIENT'; END IF;
END $$;
`;

export const cashCreditGuardsSql = `
CREATE OR REPLACE FUNCTION zwanga_booking_cash_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t trips%ROWTYPE; c cash_commissions%ROWTYPE; next_state text; require_funds boolean; validate_mode boolean; rate numeric; request_policy smallint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO c FROM cash_commissions WHERE "bookingId" = OLD.id;
    IF FOUND AND c.state = 'reserved' THEN PERFORM zwanga_cash_sync(c."bookingId",c."driverId",c."tripId",0,c."moneyPerToken",'released',false); END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO t FROM trips WHERE id = NEW."tripId";
  IF NOT FOUND THEN RETURN NEW; END IF;
  validate_mode := TG_OP = 'INSERT';
  IF TG_OP = 'INSERT' AND t."tripRequestId" IS NOT NULL THEN
    SELECT "cashCommissionPolicyVersion" INTO request_policy FROM trip_requests WHERE id = t."tripRequestId";
    NEW."cashCommissionPolicyVersion" := COALESCE(request_policy,NEW."cashCommissionPolicyVersion");
  END IF;
  IF TG_OP = 'UPDATE' THEN
    validate_mode := OLD."paymentMode" IS DISTINCT FROM NEW."paymentMode" OR (OLD.status = 'pending' AND NEW.status = 'accepted');
    IF OLD.status = 'completed' AND NEW.status IN ('pending','accepted') THEN RAISE EXCEPTION 'CASH_STATE_CONFLICT'; END IF;
    IF OLD."cashReceivedAt" IS NOT NULL AND OLD."paymentMode" IS DISTINCT FROM NEW."paymentMode" THEN RAISE EXCEPTION 'CASH_STATE_CONFLICT'; END IF;
  END IF;
  IF validate_mode AND COALESCE(NEW."paymentAmount",0) > 0 AND NOT (NEW."paymentMode" = ANY(t."acceptedPaymentModes")) THEN RAISE EXCEPTION 'TRIP_PAYMENT_MODE_UNAVAILABLE'; END IF;
  IF NEW."cashCommissionPolicyVersion" = 0 THEN RETURN NEW; END IF;
  -- Transfer the dispatch hold to its actual booking, under the same wallet lock.
  -- Pending creation must not release the hold while acceptance is still in progress.
  IF t."tripRequestId" IS NOT NULL AND NEW.status <> 'pending' THEN
    PERFORM 1 FROM users WHERE id = t."driverId" FOR KEY SHARE;
    PERFORM 1 FROM wallet_accounts WHERE "userId" = t."driverId" AND type = 'points' FOR UPDATE;
    UPDATE cash_commissions SET "bookingId" = NEW.id, "tripId" = t.id
      WHERE "requestId" = t."tripRequestId" AND "bookingId" = "requestId" AND "driverId" = t."driverId";
  END IF;
  SELECT * INTO c FROM cash_commissions WHERE "bookingId" = NEW.id;
  IF NEW."paymentMode" <> 'cash' OR NEW.status IN ('cancelled','rejected','expired','pending','no_show','boarding_uncertain') OR COALESCE(NEW."paymentAmount",0) <= 0 THEN
    IF c."bookingId" IS NOT NULL AND c.state <> 'released' THEN PERFORM zwanga_cash_sync(NEW.id,t."driverId",t.id,0,c."moneyPerToken",'released',false); END IF;
    RETURN NEW;
  END IF;
  IF NEW."paymentCurrency" <> 'CDF' THEN RAISE EXCEPTION 'CASH_CURRENCY_UNSUPPORTED'; END IF;
  rate := COALESCE(c."commissionRate",0.05);
  next_state := CASE WHEN NEW.status = 'completed' THEN 'captured' ELSE 'reserved' END;
  require_funds := c."bookingId" IS NULL OR c.state = 'released' OR
    (NOT COALESCE(NEW."pickedUp",false) AND round(round(NEW."paymentAmount" * rate,2) / COALESCE(c."moneyPerToken",NEW."cashCommissionTokenValue"),2) > c."tokensDue");
  -- Never block completion of a ride already boarded; record the final shortfall.
  IF TG_OP = 'UPDATE' AND c."bookingId" IS NOT NULL AND OLD.status IN ('no_show','boarding_uncertain')
    AND OLD."paymentMode" = 'cash' AND COALESCE(NEW."pickedUp",false) THEN require_funds := false; END IF;
  PERFORM zwanga_cash_sync(NEW.id,t."driverId",t.id,NEW."paymentAmount",NEW."cashCommissionTokenValue",next_state,require_funds,
    CASE WHEN NEW."cashCommissionPolicyVersion" >= 2 THEN 25 ELSE 0 END);
  RETURN NEW;
END $$;

CREATE FUNCTION zwanga_publication_cash_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r trip_requests%ROWTYPE;
BEGIN
  IF NEW."isFree" OR NOT ('cash' = ANY(NEW."acceptedPaymentModes")) THEN RETURN NEW; END IF;
  IF NEW."isPrivate" THEN
    -- Catch insufficient funds before creating the private trip. A dispatch
    -- selection already has its own hold and must not be counted twice.
    IF TG_OP = 'INSERT' AND NEW."tripRequestId" IS NOT NULL THEN
      SELECT * INTO r FROM trip_requests WHERE id = NEW."tripRequestId";
      IF r."paymentMode" = 'cash' AND NOT EXISTS (SELECT 1 FROM cash_commissions WHERE "requestId" = r.id AND "driverId" = NEW."driverId" AND state = 'reserved') THEN
        PERFORM zwanga_cash_check_capacity(NEW."driverId",NEW."pricePerSeat" * r."numberOfSeats");
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW."pricePerSeat",NEW."totalSeats",NEW."acceptedPaymentModes") IS NOT DISTINCT FROM
    ROW(OLD."pricePerSeat",OLD."totalSeats",OLD."acceptedPaymentModes") THEN RETURN NEW; END IF;
  PERFORM zwanga_cash_check_capacity(NEW."driverId",NEW."pricePerSeat" * NEW."totalSeats");
  RETURN NEW;
END $$;
CREATE TRIGGER publication_cash_guard BEFORE INSERT OR UPDATE OF "acceptedPaymentModes","pricePerSeat","totalSeats" ON trips
  FOR EACH ROW EXECUTE FUNCTION zwanga_publication_cash_guard();

CREATE FUNCTION zwanga_request_cash_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c cash_commissions%ROWTYPE; rid uuid; did uuid;
BEGIN
  rid := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  SELECT * INTO c FROM cash_commissions WHERE "requestId" = rid AND "bookingId" = rid;
  IF TG_OP = 'DELETE' THEN
    IF c.state = 'reserved' THEN PERFORM zwanga_cash_sync(rid,c."driverId",c."tripId",0,c."moneyPerToken",'released',false); END IF;
    RETURN OLD;
  END IF;
  IF NEW.status <> 'driver_selected' OR NEW."paymentMode" <> 'cash' THEN
    IF c.state = 'reserved' THEN PERFORM zwanga_cash_sync(rid,c."driverId",c."tripId",0,c."moneyPerToken",'released',false); END IF;
    RETURN NEW;
  END IF;
  -- Direct acceptance has already reserved the actual booking; do not double count.
  IF NEW."tripId" IS NOT NULL OR NEW."cashCommissionPolicyVersion" < 2 THEN RETURN NEW; END IF;
  did := NEW."selectedDriverId";
  IF did IS NULL OR NEW."selectedPricePerSeat" IS NULL THEN RAISE EXCEPTION 'CASH_INVALID_AMOUNT'; END IF;
  IF c."bookingId" IS NOT NULL AND c.state = 'released' AND c."driverId" <> did THEN
    -- Preserve the old zeroed history when an overdue driver is replaced.
    UPDATE cash_commissions SET "bookingId" = uuid_generate_v4(), "requestId" = NULL WHERE "bookingId" = rid AND state = 'released';
    c := NULL;
  END IF;
  PERFORM zwanga_cash_sync(rid,did,rid,NEW."selectedPricePerSeat" * NEW."numberOfSeats",100,'reserved',
    c."bookingId" IS NULL OR c.state = 'released' OR NEW."selectedPricePerSeat" * NEW."numberOfSeats" > c."baseAmount",25);
  UPDATE cash_commissions SET "requestId" = rid WHERE "bookingId" = rid;
  RETURN NEW;
END $$;
CREATE TRIGGER request_cash_guard BEFORE INSERT OR DELETE OR UPDATE OF status,"selectedDriverId","selectedPricePerSeat","numberOfSeats","paymentMode","tripId" ON trip_requests
  FOR EACH ROW EXECUTE FUNCTION zwanga_request_cash_guard();
`;
