// Immutable migration: amounts are CDF minor units. One token is 10 CDF;
// collection rounds down to 0.1 CDF (the wallet's 0.01-token precision).
export const assetCreditCollections = `
CREATE FUNCTION zwanga_asset_wallet_debit(did uuid, amount_minor bigint, cid uuid, source text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE a wallet_accounts%ROWTYPE; tokens numeric; lid uuid;
BEGIN
  SELECT * INTO a FROM wallet_accounts WHERE "userId"=did AND type='points' FOR UPDATE;
  tokens := amount_minor::numeric / 1000;
  IF amount_minor<=0 OR amount_minor%10<>0 OR a.id IS NULL OR a."withdrawalsBlocked"
    OR GREATEST(0,a."withdrawableBalance"-a."reservedCashCommissionBalance")<tokens THEN RAISE EXCEPTION 'ASSET_BALANCE'; END IF;
  UPDATE wallet_accounts SET balance=balance-tokens,"withdrawableBalance"="withdrawableBalance"-tokens,"updatedAt"=now() WHERE id=a.id RETURNING * INTO a;
  lid := uuid_generate_v4();
  INSERT INTO wallet_ledger_entries (id,"accountId","userId","accountType",type,amount,"withdrawableAmount","balanceAfter",currency,"relatedEntityType","relatedEntityId",description)
    VALUES(lid,a.id,did,'points','asset_credit_repayment',-tokens,-tokens,a.balance,a.currency,'asset_credit',cid,'Remboursement matériel Zwanga');
  RETURN lid;
END $$;

CREATE FUNCTION zwanga_asset_wallet_repay(cid uuid,did uuid,amount_minor bigint,mutation uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c asset_credits%ROWTYPE; previous asset_credit_wallet_mutations%ROWTYPE; lid uuid; due_paid bigint;
BEGIN
  -- Wallet before driver credit lock; electronic allocations never acquire this wallet lock.
  PERFORM 1 FROM wallet_accounts WHERE "userId"=did AND type='points' FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('asset-driver:'||did::text,0));
  SELECT * INTO previous FROM asset_credit_wallet_mutations WHERE id=mutation;
  IF FOUND THEN
    IF previous."driverId"<>did OR previous."creditId"<>cid OR previous."amountMinor"<>amount_minor THEN RAISE EXCEPTION 'ASSET_REPLAY'; END IF;
    RETURN jsonb_build_object('id',cid,'replayed',true);
  END IF;
  SELECT * INTO c FROM asset_credits WHERE id=cid AND "driverId"=did FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ASSET_OWNER'; END IF;
  IF c.status<>'active' OR amount_minor>c."principalMinor"-c."paidMinor" THEN RAISE EXCEPTION 'ASSET_STATE'; END IF;
  due_paid:=LEAST(c."dueMinor",amount_minor);
  lid:=zwanga_asset_wallet_debit(did,amount_minor,cid,mutation::text);
  UPDATE asset_credits SET "paidMinor"="paidMinor"+amount_minor,"dueMinor"="dueMinor"-due_paid,
    status=CASE WHEN "paidMinor"+amount_minor="principalMinor" THEN 'settled' ELSE 'active' END WHERE id=cid;
  INSERT INTO asset_credit_entries("creditId","driverId",kind,"amountMinor","dueDeltaMinor","sourceKey","walletEntryId")
    VALUES(cid,did,'wallet',amount_minor,-due_paid,'wallet:'||mutation::text,lid);
  INSERT INTO asset_credit_wallet_mutations(id,"driverId","creditId","amountMinor") VALUES(mutation,did,cid,amount_minor);
  RETURN jsonb_build_object('id',cid,'replayed',false);
END $$;

CREATE FUNCTION zwanga_asset_collect(did uuid,bid uuid,kind text,target_minor bigint,earned_at timestamptz) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE source text:=kind||':'||bid::text; prior asset_credit_sources%ROWTYPE; c asset_credits%ROWTYPE;
  budget bigint; allocation bigint; paid bigint; owed bigint; lid uuid; available bigint; total_paid bigint:=0; e record;
BEGIN
  IF target_minor<0 OR kind NOT IN ('trip_cash','trip_earning') THEN RAISE EXCEPTION 'ASSET_STATE'; END IF;
  IF kind='trip_cash' THEN PERFORM 1 FROM wallet_accounts WHERE "userId"=did AND type='points' FOR UPDATE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('asset-driver:'||did::text,0));
  SELECT * INTO prior FROM asset_credit_sources WHERE "sourceKey"=source;
  IF FOUND AND prior."driverId"<>did THEN RAISE EXCEPTION 'ASSET_OWNER'; END IF;
  IF NOT FOUND THEN
    INSERT INTO asset_credit_sources("sourceKey","driverId") VALUES(source,did) RETURNING * INTO prior;
  END IF;
  IF target_minor=prior."targetMinor" THEN RETURN prior."collectedMinor"; END IF;
  budget:=target_minor-prior."targetMinor";
  IF budget<0 THEN
    IF kind='trip_cash' THEN RAISE EXCEPTION 'ASSET_CASH_RECONCILIATION_REQUIRED'; END IF;
    -- Only collected credit is reversed. The historical trip commission stays untouched.
    budget:=GREATEST(0,prior."collectedMinor"-target_minor);
    FOR e IN SELECT "creditId",SUM("amountMinor") AS paid,SUM("dueDeltaMinor") AS due FROM asset_credit_entries WHERE "sourceKey"=source GROUP BY "creditId" HAVING SUM("amountMinor")>0 ORDER BY "creditId" LOOP
      EXIT WHEN budget=0;
      paid:=LEAST(budget,e.paid); budget:=budget-paid;
      owed:=LEAST(paid,GREATEST(0,-e.due));
      UPDATE asset_credits SET "paidMinor"="paidMinor"-paid,"dueMinor"="dueMinor"+owed,status='active' WHERE id=e."creditId";
      INSERT INTO asset_credit_entries("creditId","driverId","bookingId",kind,"amountMinor","dueDeltaMinor","sourceKey") VALUES(e."creditId",did,bid,'reversal',-paid,owed,source);
      total_paid:=total_paid-paid;
    END LOOP;
  ELSE
    FOR c IN SELECT * FROM asset_credits WHERE "driverId"=did AND status='active' AND "activatedAt"<=earned_at ORDER BY "activatedAt",id FOR UPDATE LOOP
      EXIT WHEN budget<=0;
      allocation:=LEAST(budget,c."principalMinor"-c."paidMinor");
      IF allocation<=0 THEN CONTINUE; END IF;
      paid:=allocation; owed:=-LEAST(paid,c."dueMinor"); lid:=NULL;
      IF kind='trip_cash' THEN
        SELECT CASE WHEN "withdrawalsBlocked" THEN 0 ELSE floor(GREATEST(0,"withdrawableBalance"-"reservedCashCommissionBalance")*100)*10 END
          INTO available FROM wallet_accounts WHERE "userId"=did AND type='points';
        paid:=LEAST(allocation,COALESCE(available,0));
        owed:=-LEAST(paid,c."dueMinor");
        owed:=owed+LEAST(allocation-paid,c."principalMinor"-c."paidMinor"-paid-c."dueMinor"-owed);
        IF paid>0 THEN lid:=zwanga_asset_wallet_debit(did,paid,c.id,source); END IF;
      END IF;
      UPDATE asset_credits SET "paidMinor"="paidMinor"+paid,"dueMinor"="dueMinor"+owed,
        status=CASE WHEN "paidMinor"+paid="principalMinor" THEN 'settled' ELSE 'active' END WHERE id=c.id;
      IF paid<>0 OR owed<>0 THEN
        INSERT INTO asset_credit_entries("creditId","driverId","bookingId",kind,"amountMinor","dueDeltaMinor","sourceKey","walletEntryId")
          VALUES(c.id,did,bid,kind,paid,owed,source,lid);
      END IF;
      budget:=budget-allocation; total_paid:=total_paid+paid;
    END LOOP;
  END IF;
  UPDATE asset_credit_sources SET "targetMinor"=target_minor,"collectedMinor"="collectedMinor"+total_paid WHERE "sourceKey"=source RETURNING * INTO prior;
  RETURN prior."collectedMinor";
END $$;

CREATE FUNCTION zwanga_asset_earning_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target bigint; previous_target bigint; paid bigint;
BEGIN
  -- No retrofit to historical earnings: eligibility is pinned to the earning date.
  IF NOT EXISTS(SELECT 1 FROM asset_credits WHERE "driverId"=NEW."driverId" AND status='active' AND "activatedAt"<=NEW."createdAt")
    AND NOT EXISTS(SELECT 1 FROM asset_credit_sources WHERE "sourceKey"='trip_earning:'||NEW."bookingId"::text) THEN RETURN NEW; END IF;
  IF NEW.currency<>'CDF' THEN RETURN NEW; END IF;
  target:=CASE WHEN NEW.status='cancelled' THEN 0 ELSE LEAST(floor(NEW."grossAmount"*0.05*10)*10,floor(NEW."netAmount"*10)*10)::bigint END;
  paid:=zwanga_asset_collect(NEW."driverId",NEW."bookingId",'trip_earning',target,NEW."createdAt");
  NEW."assetRepaymentAmount":=paid::numeric/100;
  RETURN NEW;
END $$;
CREATE TRIGGER asset_earning_collection BEFORE INSERT OR UPDATE OF "grossAmount","netAmount",status ON driver_earnings FOR EACH ROW EXECUTE FUNCTION zwanga_asset_earning_trigger();

CREATE FUNCTION zwanga_asset_cash_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE did uuid; target bigint;
BEGIN
  IF NEW."paymentMode"<>'cash' OR NEW.status<>'completed' OR NEW."cashReceivedAt" IS NULL OR NEW."paymentCurrency"<>'CDF' THEN RETURN NEW; END IF;
  SELECT "driverId" INTO did FROM trips WHERE id=NEW."tripId";
  IF NEW."cashReceivedByDriverId" IS DISTINCT FROM did THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM asset_credits WHERE "driverId"=did AND status='active' AND "activatedAt"<=NEW."cashReceivedAt")
    AND NOT EXISTS(SELECT 1 FROM asset_credit_sources WHERE "sourceKey"='trip_cash:'||NEW.id::text) THEN RETURN NEW; END IF;
  target:=floor(GREATEST(0,NEW."cashReceivedAmount")*0.05*10)*10;
  PERFORM zwanga_asset_collect(did,NEW.id,'trip_cash',target,NEW."cashReceivedAt");
  RETURN NEW;
END $$;
CREATE TRIGGER asset_cash_collection AFTER INSERT OR UPDATE OF status,"cashReceivedAt","cashReceivedAmount","paymentMode" ON bookings FOR EACH ROW EXECUTE FUNCTION zwanga_asset_cash_trigger();
`;
