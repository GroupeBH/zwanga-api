// Immutable policy for 1780000118000. The existing wallet lock serializes all
// cash admissions; no external calls occur in transactions.
export const driverCashCreditSql = `
CREATE TABLE driver_cash_credit_trips (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "driverId" uuid NOT NULL REFERENCES users(id),
  "journeyId" uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved','consumed','released')),
  "grantedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("driverId","journeyId")
);
CREATE INDEX "IDX_cash_credit_passenger_trips" ON bookings ("tripId")
  WHERE status IN ('accepted','completed');
ALTER TABLE cash_commissions ADD COLUMN "cashCreditTripId" uuid REFERENCES driver_cash_credit_trips(id);
-- A request and the trip subsequently created for it share one journey key.
CREATE FUNCTION zwanga_cash_credit_journey(tid uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT COALESCE("tripRequestId"::uuid,id) FROM trips WHERE id=tid),tid)
$$;

-- Cash trips only. Active admissions reserve a place; cancelled and
-- empty trips do not. LIMIT bounds history reads once the allowance is exhausted.
CREATE FUNCTION zwanga_cash_credit_used(did uuid, excluded uuid DEFAULT NULL) RETURNS integer
LANGUAGE sql VOLATILE AS $$
  SELECT count(*)::integer FROM (
    SELECT journey FROM (
      (SELECT "journeyId" AS journey FROM driver_cash_credit_trips
        WHERE "driverId"=did AND state <> 'released'
          AND (excluded IS NULL OR "journeyId"<>excluded) LIMIT 6)
      UNION
      (SELECT COALESCE(t."tripRequestId"::uuid,t.id) FROM trips t
        WHERE t."driverId"=did AND (excluded IS NULL OR COALESCE(t."tripRequestId"::uuid,t.id)<>excluded)
          AND EXISTS (SELECT 1 FROM bookings b WHERE b."tripId"=t.id
          AND b."passengerId" <> did AND b."paymentMode"='cash' AND b."paymentAmount">0
          AND b.status IN ('accepted','completed'))
        GROUP BY COALESCE(t."tripRequestId"::uuid,t.id) LIMIT 6)
    ) journeys WHERE excluded IS NULL OR journey <> excluded LIMIT 6
  ) bounded
$$;

CREATE FUNCTION zwanga_cash_credit_available(did uuid, journey uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM driver_cash_credit_trips WHERE "driverId"=did
    AND "journeyId"=journey AND state <> 'released') OR
    (zwanga_cash_credit_used(did,journey)<6)
$$;

CREATE FUNCTION zwanga_cash_credit_paid(did uuid) RETURNS integer LANGUAGE sql VOLATILE AS $$
  SELECT count(*)::integer FROM (
    (SELECT "journeyId" FROM driver_cash_credit_trips WHERE "driverId"=did AND state='consumed' LIMIT 6)
    UNION
    (SELECT COALESCE(t."tripRequestId"::uuid,t.id) FROM trips t WHERE t."driverId"=did
      AND EXISTS (SELECT 1 FROM bookings b WHERE b."tripId"=t.id AND b."passengerId"<>did
        AND b."paymentMode"='cash' AND b.status='completed' AND b."droppedOff"
        AND b."cashReceivedAt" IS NOT NULL AND b."cashReceivedAmount">0)
      GROUP BY COALESCE(t."tripRequestId"::uuid,t.id) LIMIT 6)
    LIMIT 6
  ) paid
$$;

CREATE FUNCTION zwanga_cash_credit_claim(did uuid, journey uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE grant_id uuid; blocked boolean;
BEGIN
  PERFORM 1 FROM users WHERE id=did FOR KEY SHARE;
  INSERT INTO wallet_accounts ("userId",type,currency) VALUES (did,'points','PTS')
    ON CONFLICT ("userId",type) DO NOTHING;
  SELECT "withdrawalsBlocked" INTO blocked FROM wallet_accounts
    WHERE "userId"=did AND type='points' FOR UPDATE;
  IF blocked THEN RETURN NULL; END IF;
  SELECT id INTO grant_id FROM driver_cash_credit_trips
    WHERE "driverId"=did AND "journeyId"=journey AND state <> 'released';
  IF grant_id IS NOT NULL THEN RETURN grant_id; END IF;
  IF NOT zwanga_cash_credit_available(did,journey) THEN RETURN NULL; END IF;
  INSERT INTO driver_cash_credit_trips ("driverId","journeyId",state)
    VALUES (did,journey,'reserved') ON CONFLICT ("driverId","journeyId") DO UPDATE
    SET state='reserved',"grantedAt"=clock_timestamp(),"updatedAt"=clock_timestamp()
    RETURNING id INTO grant_id;
  RETURN grant_id;
END $$;

CREATE FUNCTION zwanga_cash_credit_refresh(did uuid, journey uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE next_state text;
BEGIN
  PERFORM 1 FROM wallet_accounts WHERE "userId"=did AND type='points' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM trips t JOIN bookings b ON b."tripId"=t.id
    WHERE t."driverId"=did AND COALESCE(t."tripRequestId"::uuid,t.id)=journey
      AND b."passengerId"<>did AND b."paymentMode"='cash' AND b.status='completed'
      AND b."droppedOff" AND b."cashReceivedAt" IS NOT NULL AND b."cashReceivedAmount">0) THEN
    next_state := 'consumed';
  ELSIF EXISTS (SELECT 1 FROM trips t JOIN bookings b ON b."tripId"=t.id
    WHERE t."driverId"=did AND COALESCE(t."tripRequestId"::uuid,t.id)=journey
      AND b."passengerId"<>did AND b."paymentMode"='cash' AND b."paymentAmount">0 AND b.status IN ('accepted','completed')) OR
    EXISTS (SELECT 1 FROM trip_requests WHERE id=journey AND "selectedDriverId"=did
      AND status='driver_selected' AND "paymentMode"='cash' AND "tripId" IS NULL
      AND "selectedPricePerSeat" * "numberOfSeats">0) THEN
    next_state := 'reserved';
  ELSE next_state := 'released'; END IF;
  UPDATE driver_cash_credit_trips SET state=next_state,"updatedAt"=clock_timestamp()
    WHERE "driverId"=did AND "journeyId"=journey AND state = 'reserved' AND state<>next_state;
END $$;

CREATE FUNCTION zwanga_cash_credit_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t trips%ROWTYPE; journey uuid;
BEGIN
  SELECT * INTO t FROM trips WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD."tripId" ELSE NEW."tripId" END;
  IF NOT FOUND THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
  journey := COALESCE(t."tripRequestId"::uuid,t.id);
  IF TG_WHEN='BEFORE' THEN
    IF NEW.status IN ('accepted','completed') AND NEW."paymentMode"='cash' AND NEW."paymentAmount">0 AND NEW."passengerId"<>t."driverId" THEN
      PERFORM zwanga_cash_credit_claim(t."driverId",journey);
    END IF;
  ELSE
    PERFORM zwanga_cash_credit_refresh(t."driverId",journey);
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER a_cash_credit_booking BEFORE INSERT OR UPDATE OF status,"paymentMode" ON bookings
  FOR EACH ROW EXECUTE FUNCTION zwanga_cash_credit_booking();
CREATE TRIGGER z_cash_credit_booking AFTER INSERT OR DELETE OR UPDATE OF status,"paymentMode","pickedUp","droppedOff","cashReceivedAt" ON bookings
  FOR EACH ROW EXECUTE FUNCTION zwanga_cash_credit_booking();

CREATE FUNCTION zwanga_cash_credit_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_WHEN='BEFORE' THEN
    IF NEW.status='driver_selected' AND NEW."paymentMode"='cash' AND NEW."selectedDriverId" IS NOT NULL AND NEW."tripId" IS NULL
      AND NEW."selectedPricePerSeat" * NEW."numberOfSeats">0 THEN
      PERFORM zwanga_cash_credit_claim(NEW."selectedDriverId",NEW.id);
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' AND OLD."selectedDriverId" IS NOT NULL THEN
      PERFORM zwanga_cash_credit_refresh(OLD."selectedDriverId",OLD.id);
    END IF;
    IF TG_OP <> 'DELETE' AND NEW."selectedDriverId" IS NOT NULL THEN
      PERFORM zwanga_cash_credit_refresh(NEW."selectedDriverId",NEW.id);
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER a_cash_credit_request BEFORE INSERT OR UPDATE OF status,"selectedDriverId","paymentMode","tripId" ON trip_requests
  FOR EACH ROW EXECUTE FUNCTION zwanga_cash_credit_request();
CREATE TRIGGER z_cash_credit_request AFTER INSERT OR DELETE OR UPDATE OF status,"selectedDriverId","paymentMode","tripId" ON trip_requests
  FOR EACH ROW EXECUTE FUNCTION zwanga_cash_credit_request();

-- Enrich the existing durable driver receipt, not an extra push. The service's
-- unique eventKey still deduplicates retries; passenger receipts are unchanged.
CREATE FUNCTION zwanga_cash_credit_receipt_notice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c cash_commissions%ROWTYPE; due numeric; paid integer;
BEGIN
  IF COALESCE(NEW.data->>'bookingId','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN NEW; END IF;
  SELECT * INTO c FROM cash_commissions WHERE "bookingId"=(NEW.data->>'bookingId')::uuid AND "driverId"=NEW."userId";
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT COALESCE(SUM("debtTokens"*"moneyPerToken"),0) INTO due FROM cash_commissions
    WHERE "driverId"=NEW."userId" AND "debtTokens">0;
  paid := zwanga_cash_credit_paid(NEW."userId");
  NEW.body := COALESCE(NEW.body,'') || ' Commission Zwanga 5 % : ' || c."commissionAmount"::text ||
    ' FC. Total restant dû : ' || round(due,2)::text || ' FC. Trajets cash payés : ' || paid::text || '/6. ' ||
    CASE WHEN paid < 6 THEN 'Cette avance est unique. Après six trajets, régularisez le dû et provisionnez vos jetons.'
    ELSE 'Avance terminée : régularisez le dû et provisionnez vos jetons avant un nouveau trajet cash.' END;
  NEW.data := NEW.data || jsonb_build_object('cashCommissionAmount',c."commissionAmount",
    'cashCommissionDebtAmount',round(due,2),'cashCreditPaidTrips',paid,'cashCreditTripLimit',6);
  RETURN NEW;
END $$;
CREATE TRIGGER cash_credit_receipt_notice BEFORE INSERT ON notifications FOR EACH ROW
  WHEN (NEW.data->>'type'='cash_payment_confirmed' AND NEW.data->>'role'='driver')
  EXECUTE FUNCTION zwanga_cash_credit_receipt_notice();
`;
