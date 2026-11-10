import { MigrationInterface, QueryRunner } from 'typeorm';
import { driverCashCreditSql } from './sql/driver-cash-credit';

/** Six first cash trips on credit, once per driver. Never waive or reprice fees. */
export class DriverCashSixTripCredit1780000118000 implements MigrationInterface {
  name = 'DriverCashSixTripCredit1780000118000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Cash credit requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    await runner.query(
      'CREATE TABLE driver_cash_credit_function_backup (signature text PRIMARY KEY, definition text NOT NULL)',
    );
    const read = async (signature: string): Promise<string> => {
      const [row] = (await runner.query(
        'SELECT pg_get_functiondef($1::regprocedure) AS definition',
        [signature],
      )) as { definition: string }[];
      if (!row?.definition) throw new Error('Missing cash function');
      await runner.query(
        'INSERT INTO driver_cash_credit_function_backup VALUES ($1,$2)',
        [signature, row.definition],
      );
      return row.definition;
    };
    const replace = (body: string, before: string, after: string) => {
      if (body.split(before).length !== 2)
        throw new Error('Unexpected cash policy; refusing to overwrite it');
      return body.replace(before, after);
    };
    let sync = await read(
      'zwanga_cash_sync(uuid,uuid,uuid,numeric,numeric,text,boolean,numeric)',
    );
    const capacity = await read('zwanga_cash_check_capacity(uuid,numeric)');
    const requestGuard = await read('zwanga_request_cash_guard()');
    await runner.query(
      replace(requestGuard, ",100,'reserved',", ",10,'reserved',"),
    );
    await runner.query(driverCashCreditSql);
    sync = replace(
      sync,
      '  previous := c; old_reserved := c."reservedTokens";',
      `
  IF target_state <> 'released' AND c.state = 'released' THEN
    UPDATE cash_commissions SET "cashCreditTripId"=(SELECT id FROM driver_cash_credit_trips
      WHERE "driverId"=did AND "journeyId"=zwanga_cash_credit_journey(tid) AND state <> 'released'),
      "creditLimitTokens"=0 WHERE "bookingId"=bid RETURNING * INTO c;
  END IF;
  previous := c; old_reserved := c."reservedTokens";`,
    );
    const guardStart = sync.indexOf('  IF require_funds THEN');
    const guardEnd = sync.indexOf(
      "  IF target_state = 'reserved' THEN",
      guardStart,
    );
    if (guardStart < 0 || guardEnd < guardStart)
      throw new Error('Missing cash credit guard');
    const guard = sync.slice(guardStart, guardEnd);
    if (
      !guard.includes('other_debt +') ||
      !guard.includes('CASH_COMMISSION_INSUFFICIENT')
    )
      throw new Error('Unexpected cash credit guard');
    sync = replace(
      sync,
      guard,
      `  IF require_funds THEN
    IF a."withdrawalsBlocked" THEN RAISE EXCEPTION 'CASH_COMMISSION_INSUFFICIENT'; END IF;
    IF c."cashCreditTripId" IS NULL THEN
      IF other_debt + c."debtTokens" > 0 THEN RAISE EXCEPTION 'CASH_DEBT_OUTSTANDING'; END IF;
      IF due > available + c."chargedTokens" THEN RAISE EXCEPTION 'CASH_COMMISSION_INSUFFICIENT'; END IF;
    END IF;
  END IF;
`,
    );
    sync = replace(
      sync,
      ' jetons dus. Le cash reste disponible si la dette totale après la prochaine commission ne dépasse pas 25 jetons. Rechargez ou recevez des jetons pour régulariser. Les courses confirmées peuvent se terminer.',
      ' jetons de commission cash dus. L’avance concerne uniquement vos six premiers trajets cash. Ensuite, régularisez le dû et provisionnez vos jetons avant un nouveau trajet cash. Les courses confirmées peuvent se terminer.',
    );
    await runner.query(sync);
    if (!capacity.includes('GREATEST(0,25 - debt)'))
      throw new Error('Unexpected publication capacity policy');
    await runner.query(`CREATE OR REPLACE FUNCTION zwanga_cash_check_capacity(did uuid, base numeric) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE a wallet_accounts%ROWTYPE; due numeric; debt numeric;
      BEGIN
        IF base <= 0 THEN RETURN; END IF;
        PERFORM 1 FROM users WHERE id=did FOR KEY SHARE;
        INSERT INTO wallet_accounts ("userId",type,currency) VALUES (did,'points','PTS') ON CONFLICT ("userId",type) DO NOTHING;
        SELECT * INTO a FROM wallet_accounts WHERE "userId"=did AND type='points' FOR UPDATE;
        IF a."withdrawalsBlocked" THEN RAISE EXCEPTION 'CASH_COMMISSION_INSUFFICIENT'; END IF;
        IF zwanga_cash_credit_available(did) THEN RETURN; END IF;
        SELECT COALESCE(SUM("debtTokens"),0) INTO debt FROM cash_commissions WHERE "driverId"=did AND "debtTokens">0;
        IF debt>0 THEN RAISE EXCEPTION 'CASH_DEBT_OUTSTANDING'; END IF;
        -- New quotes use 10 FC/token. Historical bookings keep their snapshot.
        due := round(round(base * 0.05,2) / 10,2);
        IF due>GREATEST(0,a.balance-a."reservedCashCommissionBalance") THEN RAISE EXCEPTION 'CASH_COMMISSION_INSUFFICIENT'; END IF;
      END $$`);
  }

  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Cash credit rollback requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    const [row] =
      (await runner.query(`SELECT EXISTS(SELECT 1 FROM driver_cash_credit_trips)
      OR EXISTS(SELECT 1 FROM cash_commissions WHERE "cashCreditTripId" IS NOT NULL) AS used`)) as {
        used: boolean;
      }[];
    if (row.used)
      throw new Error(
        'Cannot erase cash credit history; use a forward migration',
      );
    for (const item of (await runner.query(
      'SELECT definition FROM driver_cash_credit_function_backup',
    )) as { definition: string }[])
      await runner.query(item.definition);
    await runner.query(`
      DROP TRIGGER cash_credit_receipt_notice ON notifications;
      DROP FUNCTION zwanga_cash_credit_receipt_notice();
      DROP TRIGGER a_cash_credit_booking ON bookings;
      DROP TRIGGER z_cash_credit_booking ON bookings;
      DROP TRIGGER a_cash_credit_request ON trip_requests;
      DROP TRIGGER z_cash_credit_request ON trip_requests;
      DROP FUNCTION zwanga_cash_credit_booking(), zwanga_cash_credit_request();
      DROP FUNCTION zwanga_cash_credit_refresh(uuid,uuid), zwanga_cash_credit_claim(uuid,uuid);
      DROP FUNCTION zwanga_cash_credit_available(uuid,uuid);
      DROP FUNCTION zwanga_cash_credit_used(uuid,uuid), zwanga_cash_credit_paid(uuid), zwanga_cash_credit_journey(uuid);
      ALTER TABLE cash_commissions DROP COLUMN "cashCreditTripId";
      DROP INDEX "IDX_cash_credit_passenger_trips";
      DROP TABLE driver_cash_credit_trips, driver_cash_credit_function_backup;
    `);
  }
}
