// Policy v1: first confirmed exception warns; repeats cost 3,000 CDF;
// Count once per trip, not per passenger. Fourth trip restricts new work.
// A worker safely retires the account after existing rides and payments finish.
export const driverCashExceptionsSql = `
-- Explicit release gate: deploy compatible mobile clients before enabling.
CREATE TABLE driver_cash_exception_rollout (
  id boolean PRIMARY KEY DEFAULT true CHECK (id), enabled boolean NOT NULL DEFAULT false
);
INSERT INTO driver_cash_exception_rollout(id,enabled) VALUES(true,false);
CREATE TABLE driver_cash_exceptions (
  "bookingId" uuid PRIMARY KEY REFERENCES bookings(id),
  "driverId" uuid NOT NULL REFERENCES users(id),
  "tripId" uuid NOT NULL REFERENCES trips(id),
  "authorizedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "confirmedAt" timestamptz
);
CREATE INDEX "IDX_cash_exceptions_trip" ON driver_cash_exceptions("tripId");
CREATE INDEX "IDX_cash_exceptions_driver" ON driver_cash_exceptions("driverId");
-- One immutable incident identity per trip; each receipt keeps its own authorization.
CREATE TABLE driver_cash_exception_trips (
  "tripId" uuid PRIMARY KEY REFERENCES trips(id),
  "driverId" uuid NOT NULL REFERENCES users(id),
  "firstBookingId" uuid NOT NULL REFERENCES bookings(id),
  "confirmedAt" timestamptz NOT NULL,
  occurrence integer NOT NULL CHECK (occurrence>0),
  "penaltyAmount" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("penaltyAmount" IN (0,3000)),
  "moneyPerToken" numeric(12,2) NOT NULL DEFAULT 10 CHECK ("moneyPerToken">0),
  "chargedTokens" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("chargedTokens">=0),
  "chargedWithdrawableTokens" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("chargedWithdrawableTokens">=0 AND "chargedWithdrawableTokens"<="chargedTokens"),
  CHECK ("penaltyAmount"=CASE WHEN occurrence=1 THEN 0 ELSE 3000 END),
  CHECK ("chargedTokens" <= round("penaltyAmount"/"moneyPerToken",2)),
  UNIQUE ("driverId",occurrence)
);
CREATE INDEX "IDX_cash_exception_trips_booking" ON driver_cash_exception_trips("firstBookingId");
CREATE INDEX "IDX_cash_exception_trips_due" ON driver_cash_exception_trips("driverId",occurrence)
  WHERE "chargedTokens"<round("penaltyAmount"/"moneyPerToken",2);
CREATE TABLE driver_cash_restrictions (
  "driverId" uuid PRIMARY KEY REFERENCES users(id),
  "restrictedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "deactivatedAt" timestamptz
);
CREATE INDEX "IDX_cash_restrictions_pending" ON driver_cash_restrictions("restrictedAt","driverId") WHERE "deactivatedAt" IS NULL;

-- The wallet lock used by commission settlement serializes concurrent receipts.
CREATE FUNCTION zwanga_cash_exception_authorize(bid uuid,did uuid,tid uuid,base numeric,token_value numeric)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE a wallet_accounts%ROWTYPE; debt numeric; due numeric;
BEGIN
  IF NOT zwanga_cash_policy_enabled() THEN RETURN false; END IF;
  IF NOT COALESCE((SELECT enabled FROM driver_cash_exception_rollout WHERE id),false) THEN RETURN false; END IF;
  PERFORM 1 FROM users WHERE id=did AND "isActive" AND status='active' FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CASH_EXCEPTION_ACCOUNT_UNAVAILABLE'; END IF;
  INSERT INTO wallet_accounts("userId",type,currency) VALUES(did,'points','PTS') ON CONFLICT("userId",type) DO NOTHING;
  SELECT * INTO a FROM wallet_accounts WHERE "userId"=did AND type='points' FOR UPDATE;
  IF a."withdrawalsBlocked" THEN RETURN false; END IF;
  SELECT COALESCE(SUM("debtTokens"),0) INTO debt FROM cash_commissions WHERE "driverId"=did AND "debtTokens">0;
  due := round(round(base*0.05,2)/token_value,2);
  IF zwanga_cash_credit_available(did,zwanga_cash_credit_journey(tid)) OR
    (debt=0 AND GREATEST(0,a.balance-a."reservedCashCommissionBalance")>=due) THEN RETURN false; END IF;
  INSERT INTO driver_cash_exceptions("bookingId","driverId","tripId") VALUES(bid,did,tid)
    ON CONFLICT("bookingId") DO NOTHING;
  RETURN true;
END $$;

ALTER TABLE wallet_ledger_entries DROP CONSTRAINT "CHK_wallet_ledger_type";
ALTER TABLE wallet_ledger_entries ADD CONSTRAINT "CHK_wallet_ledger_type" CHECK (type IN
  ('top_up','loyalty_reward','booking_payment','booking_refund','booking_fare_adjustment','subscription_payment',
   'subscription_reward','transfer_out','transfer_in','admin_adjustment','withdrawal','withdrawal_refund',
   'cash_commission','cash_commission_refund','asset_credit_repayment','cash_penalty'));

CREATE FUNCTION zwanga_cash_exception_collect(did uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a wallet_accounts%ROWTYPE; e driver_cash_exception_trips%ROWTYPE;
  c cash_commissions%ROWTYPE; charge numeric; purchased numeric;
BEGIN
  -- Do not re-run commission reconciliation for ordinary wallets or the free warning.
  IF NOT EXISTS(SELECT 1 FROM driver_cash_exception_trips WHERE "driverId"=did
    AND "chargedTokens"<round("penaltyAmount"/"moneyPerToken",2)) THEN RETURN; END IF;
  PERFORM 1 FROM users WHERE id=did FOR KEY SHARE;
  SELECT * INTO a FROM wallet_accounts WHERE "userId"=did AND type='points' FOR UPDATE;
  IF NOT FOUND OR a."withdrawalsBlocked" THEN RETURN; END IF;
  -- Commission debt/reservations have priority, even on a receipt without a new credit.
  -- Reuse the origin-preserving commission collector under the same wallet lock.
  FOR c IN SELECT * FROM cash_commissions WHERE "driverId"=did AND "debtTokens">0 ORDER BY "createdAt","bookingId" LOOP
    PERFORM zwanga_cash_sync(c."bookingId",c."driverId",c."tripId",c."baseAmount",c."moneyPerToken",c.state,false);
  END LOOP;
  IF EXISTS(SELECT 1 FROM cash_commissions WHERE "driverId"=did AND "debtTokens">0) THEN RETURN; END IF;
  SELECT * INTO a FROM wallet_accounts WHERE "userId"=did AND type='points';
  FOR e IN SELECT * FROM driver_cash_exception_trips WHERE "driverId"=did
    AND "chargedTokens"<round("penaltyAmount"/"moneyPerToken",2) ORDER BY occurrence FOR UPDATE LOOP
    charge := LEAST(round(e."penaltyAmount"/e."moneyPerToken",2)-e."chargedTokens",
      GREATEST(0,a.balance-a."reservedCashCommissionBalance"));
    IF charge<=0 THEN RETURN; END IF;
    purchased := GREATEST(0,charge-GREATEST(0,a.balance-a."withdrawableBalance"-a."reservedCashCommissionBalance"));
    UPDATE wallet_accounts SET balance=balance-charge,"withdrawableBalance"="withdrawableBalance"-purchased,
      "updatedAt"=now() WHERE id=a.id RETURNING * INTO a;
    UPDATE driver_cash_exception_trips SET "chargedTokens"="chargedTokens"+charge,
      "chargedWithdrawableTokens"="chargedWithdrawableTokens"+purchased WHERE "tripId"=e."tripId";
    INSERT INTO wallet_ledger_entries("accountId","userId","accountType",type,amount,"withdrawableAmount",
      "balanceAfter",currency,"relatedEntityType","relatedEntityId",description)
      VALUES(a.id,did,'points','cash_penalty',-charge,-purchased,a.balance,a.currency,'cash_exception_trip',e."tripId",
        'Pénalité de récidive cash non éligible (hors commission)');
  END LOOP;
END $$;
CREATE FUNCTION zwanga_cash_exception_credit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount>0 AND NEW."accountType"='points' THEN PERFORM zwanga_cash_exception_collect(NEW."userId"); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_cash_exception_credit AFTER INSERT ON wallet_ledger_entries FOR EACH ROW
  EXECUTE FUNCTION zwanga_cash_exception_credit();

CREATE FUNCTION zwanga_cash_exception_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e driver_cash_exceptions%ROWTYPE; n integer; acknowledged text; already_counted boolean;
BEGIN
  IF NEW."cashReceivedAt" IS NULL OR OLD."cashReceivedAt" IS NOT NULL THEN RETURN NEW; END IF;
  SELECT * INTO e FROM driver_cash_exceptions WHERE "bookingId"=NEW.id;
  IF NOT FOUND OR e."confirmedAt" IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.status<>'completed' OR NOT NEW."droppedOff" OR NEW."paymentMode"<>'cash'
    OR NEW."cashReceivedByDriverId" IS DISTINCT FROM e."driverId" OR NEW."paymentStatus"<>'not_required'
    OR NEW."cashReceivedAmount" IS DISTINCT FROM NEW."paymentAmount" THEN RAISE EXCEPTION 'CASH_EXCEPTION_RECEIPT_INVALID'; END IF;
  PERFORM 1 FROM wallet_accounts WHERE "userId"=e."driverId" AND type='points' FOR UPDATE;
  SELECT occurrence INTO n FROM driver_cash_exception_trips WHERE "tripId"=e."tripId" AND "driverId"=e."driverId";
  already_counted := FOUND;
  IF NOT already_counted THEN
    SELECT COALESCE(MAX(occurrence),0)+1 INTO n FROM driver_cash_exception_trips WHERE "driverId"=e."driverId";
  END IF;
  acknowledged := current_setting('zwanga.cash_exception_ack',true);
  IF acknowledged IS DISTINCT FROM NEW.id::text || ':' || n::text THEN RAISE EXCEPTION 'CASH_EXCEPTION_ACK_REQUIRED'; END IF;
  UPDATE driver_cash_exceptions SET "confirmedAt"=NEW."cashReceivedAt" WHERE "bookingId"=NEW.id;
  -- Another passenger on this trip has already consumed the single incident.
  IF already_counted THEN
    PERFORM zwanga_cash_exception_collect(e."driverId");
    RETURN NEW;
  END IF;
  INSERT INTO driver_cash_exception_trips("tripId","driverId","firstBookingId","confirmedAt",occurrence,"penaltyAmount")
    VALUES(e."tripId",e."driverId",NEW.id,NEW."cashReceivedAt",n,CASE WHEN n=1 THEN 0 ELSE 3000 END);
  IF n>=4 THEN INSERT INTO driver_cash_restrictions("driverId") VALUES(e."driverId") ON CONFLICT DO NOTHING; END IF;
  PERFORM zwanga_cash_exception_collect(e."driverId");
  PERFORM zwanga_finance_notice('cash-exception-trip:' || e."tripId",e."driverId",
    CASE WHEN n=1 THEN 'Cash exceptionnel : avertissement' ELSE 'Récidive cash : pénalité de 3 000 FC' END,
    CASE WHEN n=1 THEN 'Premier trajet exceptionnel sans pénalité. La commission reste due. Prochain trajet non éligible : 3 000 FC en plus de la commission.'
    ELSE 'Une seule pénalité de 3 000 FC pour ce trajet, hors commission. Elle est prélevée après la commission sur votre solde disponible, puis sur ses prochains crédits pour le reliquat. Aucun supplément passager.' END ||
    CASE WHEN n>=4 THEN ' Nouvelles courses bloquées. Le compte sera désactivé après la dépose des passagers et le règlement des courses en cours.'
    ELSE ' À la troisième récidive, le compte est désactivé après la fin des courses en cours.' END,
    jsonb_build_object('type','cash_exception_warning','bookingId',NEW.id,'tripId',e."tripId",
      'occurrence',n,'penaltyAmount',CASE WHEN n=1 THEN 0 ELSE 3000 END,'currency','CDF'));
  RETURN NEW;
END $$;
CREATE TRIGGER cash_exception_receipt BEFORE UPDATE OF "cashReceivedAt" ON bookings FOR EACH ROW
  EXECUTE FUNCTION zwanga_cash_exception_receipt();

CREATE FUNCTION zwanga_cash_exception_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."paymentMode"<>'cash' THEN DELETE FROM driver_cash_exceptions WHERE "bookingId"=NEW.id AND "confirmedAt" IS NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_exception_release AFTER UPDATE OF "paymentMode" ON bookings FOR EACH ROW EXECUTE FUNCTION zwanga_cash_exception_release();

-- New work is blocked, but navigation, payment and closing an existing ride remain available.
CREATE FUNCTION zwanga_cash_restricted_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE did uuid;
BEGIN
  IF TG_TABLE_NAME='trips' THEN
    IF TG_OP='UPDATE' AND NOT (OLD.status IS DISTINCT FROM NEW.status AND NEW.status='ongoing'
      AND (to_jsonb(OLD)->>'startedAt') IS NULL) THEN RETURN NEW; END IF;
    did:=NEW."driverId";
  ELSIF TG_TABLE_NAME='bookings' THEN
    IF TG_OP='UPDATE' AND NOT (OLD.status IS DISTINCT FROM NEW.status AND OLD.status='pending' AND NEW.status='accepted') THEN RETURN NEW; END IF;
    SELECT "driverId" INTO did FROM trips WHERE id=NEW."tripId";
  ELSIF TG_TABLE_NAME='trip_requests' THEN
    IF NEW."selectedDriverId" IS NULL THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND OLD."selectedDriverId" IS NOT DISTINCT FROM NEW."selectedDriverId" THEN RETURN NEW; END IF;
    did:=NEW."selectedDriverId"::uuid;
  ELSE
    IF TG_OP='UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
    IF NEW.status NOT IN ('pending','accepted') THEN RETURN NEW; END IF;
    did:=NEW."driverId";
  END IF;
  PERFORM 1 FROM wallet_accounts WHERE "userId"=did AND type='points' FOR UPDATE;
  IF EXISTS(SELECT 1 FROM driver_cash_restrictions WHERE "driverId"=did) THEN RAISE EXCEPTION 'DRIVER_CASH_RESTRICTED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_restricted_admission BEFORE INSERT OR UPDATE OF status ON trips FOR EACH ROW EXECUTE FUNCTION zwanga_cash_restricted_admission();
CREATE TRIGGER cash_restricted_admission BEFORE INSERT OR UPDATE OF status ON bookings FOR EACH ROW EXECUTE FUNCTION zwanga_cash_restricted_admission();
CREATE TRIGGER cash_restricted_admission BEFORE INSERT OR UPDATE OF "selectedDriverId" ON trip_requests FOR EACH ROW EXECUTE FUNCTION zwanga_cash_restricted_admission();
CREATE TRIGGER cash_restricted_admission BEFORE INSERT OR UPDATE OF status ON driver_offers FOR EACH ROW EXECUTE FUNCTION zwanga_cash_restricted_admission();
`;
