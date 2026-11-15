// v2: snapshot eligible contracts per booking; each rate has its own target and ledger.
// v1 remains one shared 5% FIFO pool. Never rewrite historical migration SQL.
export const contractAssetCollections = `
CREATE FUNCTION zwanga_asset_collect_rates(did uuid,bid uuid,kind text,gross_minor bigint,available_minor bigint,earned_at timestamptz)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE source text:=kind||':'||bid::text; prior_driver uuid; inserted text; a record; c asset_credits%ROWTYPE;
  target bigint; delta bigint; allocation bigint; paid bigint; owed bigint; available bigint; lid uuid;
  collected bigint:=0; remaining bigint; legacy_target bigint;
BEGIN
  IF gross_minor<0 OR available_minor<0 OR kind NOT IN ('trip_cash','trip_earning') THEN RAISE EXCEPTION 'ASSET_STATE'; END IF;
  IF kind='trip_cash' THEN PERFORM 1 FROM wallet_accounts WHERE "userId"=did AND type='points' FOR UPDATE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('asset-driver:'||did::text,0));
  INSERT INTO asset_credit_rate_sources("sourceKey","driverId") VALUES(source,did)
    ON CONFLICT DO NOTHING RETURNING "sourceKey" INTO inserted;
  SELECT "driverId" INTO prior_driver FROM asset_credit_rate_sources WHERE "sourceKey"=source;
  IF prior_driver<>did THEN RAISE EXCEPTION 'ASSET_OWNER'; END IF;
  IF inserted IS NOT NULL THEN
    INSERT INTO asset_credit_rate_allocations("sourceKey","creditId","repaymentBps")
      SELECT source,id,"repaymentBps" FROM asset_credits WHERE "driverId"=did AND status='active'
        AND "policyVersion"='asset-credit-v2' AND "activatedAt"<=earned_at;
  END IF;
  legacy_target:=LEAST(floor(gross_minor::numeric*500/100000)*10,available_minor/10*10);
  IF EXISTS(SELECT 1 FROM asset_credits WHERE "driverId"=did AND status='active' AND "policyVersion"='asset-credit-v1' AND "activatedAt"<=earned_at)
    OR EXISTS(SELECT 1 FROM asset_credit_sources WHERE "sourceKey"=source) THEN
    collected:=zwanga_asset_collect(did,bid,kind,legacy_target,earned_at);
  END IF;
  remaining:=GREATEST(0,available_minor/10*10-collected);
  FOR a IN SELECT r.* FROM asset_credit_rate_allocations r JOIN asset_credits cr ON cr.id=r."creditId"
    WHERE r."sourceKey"=source ORDER BY cr."activatedAt",cr.id LOOP
    SELECT * INTO c FROM asset_credits WHERE id=a."creditId" FOR UPDATE;
    target:=LEAST(floor(gross_minor::numeric*a."repaymentBps"/100000)*10,remaining);
    delta:=target-a."targetMinor"; paid:=0; owed:=0; lid:=NULL;
    IF delta<0 THEN
      IF kind='trip_cash' THEN RAISE EXCEPTION 'ASSET_CASH_RECONCILIATION_REQUIRED'; END IF;
      paid:=-GREATEST(0,a."collectedMinor"-target);
      owed:=LEAST(-paid,GREATEST(0,-a."dueDeltaMinor"));
    ELSIF delta>0 AND c.status='active' THEN
      allocation:=LEAST(delta,c."principalMinor"-c."paidMinor");
      paid:=allocation; owed:=-LEAST(paid,c."dueMinor");
      IF kind='trip_cash' THEN
        SELECT CASE WHEN "withdrawalsBlocked" THEN 0 ELSE floor(GREATEST(0,"withdrawableBalance"-"reservedCashCommissionBalance")*100)*10 END
          INTO available FROM wallet_accounts WHERE "userId"=did AND type='points';
        paid:=LEAST(allocation,COALESCE(available,0));
        owed:=-LEAST(paid,c."dueMinor");
        owed:=owed+LEAST(allocation-paid,c."principalMinor"-c."paidMinor"-paid-c."dueMinor"-owed);
        IF paid>0 THEN lid:=zwanga_asset_wallet_debit(did,paid,c.id,source); END IF;
      END IF;
    END IF;
    IF paid<>0 OR owed<>0 THEN
      UPDATE asset_credits SET "paidMinor"="paidMinor"+paid,"dueMinor"="dueMinor"+owed,
        status=CASE WHEN "paidMinor"+paid="principalMinor" THEN 'settled' ELSE 'active' END WHERE id=c.id;
      INSERT INTO asset_credit_entries("creditId","driverId","bookingId",kind,"amountMinor","dueDeltaMinor","sourceKey","walletEntryId")
        VALUES(c.id,did,bid,CASE WHEN paid<0 THEN 'reversal' ELSE kind END,paid,owed,source,lid);
    END IF;
    UPDATE asset_credit_rate_allocations SET "targetMinor"=target,"collectedMinor"="collectedMinor"+paid,"dueDeltaMinor"="dueDeltaMinor"+owed
      WHERE "sourceKey"=source AND "creditId"=c.id;
    collected:=collected+a."collectedMinor"+paid;
    -- The cap is on agreed rates, not wallet funding; an unfunded cash debit cannot inflate another contract.
    remaining:=GREATEST(0,remaining-target);
  END LOOP;
  RETURN collected;
END $$;

CREATE OR REPLACE FUNCTION zwanga_asset_earning_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid bigint; gross_minor bigint; available_minor bigint;
BEGIN
  IF NEW.currency<>'CDF' THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM asset_credits WHERE "driverId"=NEW."driverId" AND status IN ('active','settled') AND "activatedAt"<=NEW."createdAt")
    AND NOT EXISTS(SELECT 1 FROM asset_credit_sources WHERE "sourceKey"='trip_earning:'||NEW."bookingId"::text)
    AND NOT EXISTS(SELECT 1 FROM asset_credit_rate_sources WHERE "sourceKey"='trip_earning:'||NEW."bookingId"::text) THEN RETURN NEW; END IF;
  gross_minor:=CASE WHEN NEW.status='cancelled' THEN 0 ELSE floor(GREATEST(0,NEW."grossAmount")*100)::bigint END;
  available_minor:=CASE WHEN NEW.status='cancelled' THEN 0 ELSE floor(GREATEST(0,NEW."netAmount")*10)*10 END;
  paid:=zwanga_asset_collect_rates(NEW."driverId",NEW."bookingId",'trip_earning',gross_minor,available_minor,NEW."createdAt");
  NEW."assetRepaymentAmount":=paid::numeric/100;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION zwanga_asset_cash_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE did uuid; gross_minor bigint;
BEGIN
  IF NEW."paymentMode"<>'cash' OR NEW.status<>'completed' OR NEW."cashReceivedAt" IS NULL OR NEW."paymentCurrency"<>'CDF' THEN RETURN NEW; END IF;
  SELECT "driverId" INTO did FROM trips WHERE id=NEW."tripId";
  IF NEW."cashReceivedByDriverId" IS DISTINCT FROM did THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM asset_credits WHERE "driverId"=did AND status IN ('active','settled') AND "activatedAt"<=NEW."cashReceivedAt")
    AND NOT EXISTS(SELECT 1 FROM asset_credit_sources WHERE "sourceKey"='trip_cash:'||NEW.id::text)
    AND NOT EXISTS(SELECT 1 FROM asset_credit_rate_sources WHERE "sourceKey"='trip_cash:'||NEW.id::text) THEN RETURN NEW; END IF;
  gross_minor:=floor(GREATEST(0,NEW."cashReceivedAmount")*100)::bigint;
  PERFORM zwanga_asset_collect_rates(did,NEW.id,'trip_cash',gross_minor,floor(gross_minor::numeric*0.95/10)::bigint*10,NEW."cashReceivedAt");
  RETURN NEW;
END $$;
`;
