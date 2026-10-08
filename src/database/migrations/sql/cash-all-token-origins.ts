// Immutable SQL for migration 1780000055000. Reserve rewards first; never turn
// promotional tokens into withdrawable tokens when capturing/refunding cash fees.
export const cashAllTokenOriginsSql = `
CREATE OR REPLACE FUNCTION zwanga_cash_sync(bid uuid, did uuid, tid uuid, base numeric, token_value numeric, target_state text, require_funds boolean, credit_limit numeric) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a wallet_accounts%ROWTYPE; c cash_commissions%ROWTYPE; previous cash_commissions%ROWTYPE;
  due numeric; available numeric; charge numeric := 0; purchased_charge numeric := 0;
  reserve numeric := 0; ledger_id uuid; old_reserved numeric := 0; other_debt numeric;
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
  available := GREATEST(0,a.balance - a."reservedCashCommissionBalance" + old_reserved);
  IF a."withdrawalsBlocked" THEN available := old_reserved; END IF;
  SELECT COALESCE(SUM("debtTokens"),0) INTO other_debt FROM cash_commissions WHERE "driverId" = did AND "bookingId" <> bid AND "debtTokens" > 0;
  IF require_funds THEN
    IF a."withdrawalsBlocked" THEN RAISE EXCEPTION 'CASH_COMMISSION_INSUFFICIENT'; END IF;
    IF other_debt > 0 OR (c."debtTokens" > 0 AND due > c."tokensDue") THEN RAISE EXCEPTION 'CASH_DEBT_OUTSTANDING'; END IF;
    IF GREATEST(0,due - available - c."chargedTokens") > c."creditLimitTokens" THEN RAISE EXCEPTION 'CASH_COMMISSION_INSUFFICIENT'; END IF;
  END IF;
  IF target_state = 'reserved' THEN
    IF c."chargedTokens" > 0 THEN RAISE EXCEPTION 'CASH_STATE_CONFLICT'; END IF;
    reserve := LEAST(due,available); c."chargedTokens" := 0; c."debtTokens" := due - reserve;
  ELSE
    IF due >= c."chargedTokens" THEN charge := LEAST(due - c."chargedTokens",available);
    ELSE charge := due - c."chargedTokens"; END IF;
    IF charge > 0 THEN
      -- Other holds keep priority on reward tokens. Spend only this hold + free funds.
      purchased_charge := GREATEST(0,charge - GREATEST(0,a.balance - a."withdrawableBalance" - (a."reservedCashCommissionBalance" - old_reserved)));
    ELSE
      -- Refund purchased origin first, capped by the actual outstanding purchased debit.
      purchased_charge := -LEAST(-charge,c."chargedWithdrawableTokens");
    END IF;
    c."chargedTokens" := c."chargedTokens" + charge;
    c."chargedWithdrawableTokens" := c."chargedWithdrawableTokens" + purchased_charge;
    c."debtTokens" := due - c."chargedTokens";
  END IF;
  c.state := target_state; c."tokensDue" := due; c."reservedTokens" := reserve;
  c."baseAmount" := CASE WHEN target_state = 'released' THEN 0 ELSE base END;
  c."commissionAmount" := round(c."baseAmount" * c."commissionRate",2);
  IF ROW(c.state,c."tokensDue",c."reservedTokens",c."chargedTokens",c."debtTokens",c."baseAmount") IS NOT DISTINCT FROM
     ROW(previous.state,previous."tokensDue",previous."reservedTokens",previous."chargedTokens",previous."debtTokens",previous."baseAmount") THEN RETURN; END IF;
  UPDATE wallet_accounts SET balance = balance - charge, "withdrawableBalance" = "withdrawableBalance" - purchased_charge,
    "reservedCashCommissionBalance" = "reservedCashCommissionBalance" - old_reserved + reserve, "updatedAt" = now() WHERE id = a.id RETURNING * INTO a;
  UPDATE cash_commissions SET state = c.state, "tokensDue" = c."tokensDue", "reservedTokens" = c."reservedTokens",
    "chargedTokens" = c."chargedTokens", "chargedWithdrawableTokens" = c."chargedWithdrawableTokens", "debtTokens" = c."debtTokens", "baseAmount" = c."baseAmount",
    "commissionAmount" = c."commissionAmount", revision = revision + 1, "updatedAt" = now() WHERE "bookingId" = bid RETURNING * INTO c;
  IF charge <> 0 THEN
    ledger_id := uuid_generate_v4();
    INSERT INTO wallet_ledger_entries (id,"accountId","userId","accountType",type,amount,"withdrawableAmount","balanceAfter",currency,"relatedEntityType","relatedEntityId",description)
      VALUES (ledger_id,a.id,did,'points',CASE WHEN charge > 0 THEN 'cash_commission' ELSE 'cash_commission_refund' END,-charge,-purchased_charge,a.balance,a.currency,'cash_commission',bid,
        CASE WHEN charge > 0 THEN 'Commission Zwanga ' || (c."commissionRate" * 100)::text || ' % sur paiement cash' ELSE 'Régularisation de commission cash' END);
    PERFORM zwanga_finance_notice('cash-ledger:' || ledger_id,did,CASE WHEN charge > 0 THEN 'Commission cash prélevée' ELSE 'Commission cash régularisée' END,
      abs(charge)::text || ' jetons ' || CASE WHEN charge > 0 THEN 'prélevés pour votre commission cash.' ELSE 'recrédités sur votre portefeuille.' END,
      jsonb_build_object('type','wallet_' || CASE WHEN charge > 0 THEN 'cash_commission' ELSE 'cash_commission_refund' END,'bookingId',bid,'ledgerEntryId',ledger_id,'amount',-charge,'currency',a.currency));
  END IF;
  IF c."debtTokens" > previous."debtTokens" THEN
    PERFORM zwanga_finance_notice('cash-debt:' || did || ':' || bid || ':' || c.revision,did,'Commission cash à régulariser',
      (other_debt + c."debtTokens")::text || ' jetons dus. Aucun nouveau paiement cash avant régularisation. Rechargez ou recevez des jetons. Les courses confirmées peuvent se terminer.',
      jsonb_build_object('type','cash_commission_debt','bookingId',bid,'debtTokens',other_debt + c."debtTokens"));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION zwanga_cash_check_capacity(did uuid, base numeric) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a wallet_accounts%ROWTYPE; due numeric;
BEGIN
  IF base <= 0 THEN RETURN; END IF;
  PERFORM 1 FROM users WHERE id = did FOR KEY SHARE;
  INSERT INTO wallet_accounts ("userId",type,currency) VALUES (did,'points','PTS') ON CONFLICT ("userId",type) DO NOTHING;
  SELECT * INTO a FROM wallet_accounts WHERE "userId" = did AND type = 'points' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cash_commissions WHERE "driverId" = did AND "debtTokens" > 0) THEN RAISE EXCEPTION 'CASH_DEBT_OUTSTANDING'; END IF;
  due := round(round(base * 0.05,2) / 100,2);
  IF a."withdrawalsBlocked" OR due > GREATEST(0,a.balance - a."reservedCashCommissionBalance") + 25 THEN RAISE EXCEPTION 'CASH_COMMISSION_INSUFFICIENT'; END IF;
END $$;

CREATE OR REPLACE FUNCTION zwanga_cash_reconcile_credit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c cash_commissions%ROWTYPE;
BEGIN
  IF NEW.amount <= 0 OR NOT EXISTS (SELECT 1 FROM wallet_accounts WHERE id = NEW."accountId" AND type = 'points') THEN RETURN NEW; END IF;
  PERFORM 1 FROM wallet_accounts WHERE id = NEW."accountId" FOR UPDATE;
  FOR c IN SELECT * FROM cash_commissions WHERE "driverId" = NEW."userId" AND "debtTokens" > 0 ORDER BY "createdAt", "bookingId" LOOP
    PERFORM zwanga_cash_sync(c."bookingId",c."driverId",c."tripId",c."baseAmount",c."moneyPerToken",c.state,false);
  END LOOP;
  RETURN NEW;
END $$;
`;
