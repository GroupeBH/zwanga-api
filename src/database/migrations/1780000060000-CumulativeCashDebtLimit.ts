import { MigrationInterface, QueryRunner } from 'typeorm';

export class CumulativeCashDebtLimit1780000060000 implements MigrationInterface {
  name = 'CumulativeCashDebtLimit1780000060000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Cash debt limit migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    const replace = (body: string, before: string, after: string) => {
      if (body.includes(after)) return body;
      if (body.split(before).length !== 2)
        throw new Error(
          'Unexpected cash function; refusing to change financial history',
        );
      return body.replace(before, after);
    };
    const read = async (signature: string): Promise<string> => {
      const [row] = await runner.query(
        'SELECT pg_get_functiondef($1::regprocedure) AS definition',
        [signature],
      );
      if (typeof row?.definition !== 'string')
        throw new Error('Missing cash function');
      return row.definition;
    };

    // The existing user -> wallet -> commission lock order is retained. The
    // driver's wallet lock serializes concurrent reservations across all trips.
    let sync = await read(
      'zwanga_cash_sync(uuid,uuid,uuid,numeric,numeric,text,boolean,numeric)',
    );
    sync = replace(
      sync,
      `IF other_debt > 0 OR (c."debtTokens" > 0 AND due > c."tokensDue") THEN RAISE EXCEPTION 'CASH_DEBT_OUTSTANDING'; END IF;`,
      `IF other_debt + c."debtTokens" > 25 THEN RAISE EXCEPTION 'CASH_DEBT_OUTSTANDING'; END IF;`,
    );
    sync = replace(
      sync,
      `IF GREATEST(0,due - available - c."chargedTokens") > c."creditLimitTokens" THEN RAISE EXCEPTION 'CASH_COMMISSION_INSUFFICIENT'; END IF;`,
      `IF GREATEST(0,due - available - c."chargedTokens") > c."creditLimitTokens" THEN RAISE EXCEPTION 'CASH_COMMISSION_INSUFFICIENT'; END IF;
    IF other_debt + GREATEST(0,due - available - c."chargedTokens") > 25 THEN RAISE EXCEPTION 'CASH_DEBT_OUTSTANDING'; END IF;`,
    );
    sync = replace(
      sync,
      ' jetons dus. Aucun nouveau paiement cash avant régularisation. Rechargez ou recevez des jetons. Les courses confirmées peuvent se terminer.',
      ' jetons dus. Le cash reste disponible si la dette totale après la prochaine commission ne dépasse pas 25 jetons. Rechargez ou recevez des jetons pour régulariser. Les courses confirmées peuvent se terminer.',
    );

    let capacity = await read('zwanga_cash_check_capacity(uuid,numeric)');
    capacity = replace(
      capacity,
      'DECLARE a wallet_accounts%ROWTYPE; due numeric;',
      'DECLARE a wallet_accounts%ROWTYPE; due numeric; debt numeric;',
    );
    capacity = replace(
      capacity,
      `IF EXISTS (SELECT 1 FROM cash_commissions WHERE "driverId" = did AND "debtTokens" > 0) THEN RAISE EXCEPTION 'CASH_DEBT_OUTSTANDING'; END IF;`,
      `SELECT COALESCE(SUM("debtTokens"),0) INTO debt FROM cash_commissions WHERE "driverId" = did AND "debtTokens" > 0;
  IF debt > 25 THEN RAISE EXCEPTION 'CASH_DEBT_OUTSTANDING'; END IF;`,
    );
    capacity = replace(
      capacity,
      `GREATEST(0,a.balance - a."reservedCashCommissionBalance") + 25 THEN`,
      `GREATEST(0,a.balance - a."reservedCashCommissionBalance") + GREATEST(0,25 - debt) THEN`,
    );

    // Publication eligibility must not silently bypass the ceiling in prepared
    // mode. This does NOT activate deferred commission collection or push DDL.
    let publication = await read('zwanga_publication_cash_guard()');
    publication = replace(
      publication,
      `IF NOT zwanga_cash_policy_enabled() OR NEW."isFree" OR NOT ('cash' = ANY(NEW."acceptedPaymentModes")) THEN RETURN NEW; END IF;`,
      `IF NEW."isFree" OR NOT ('cash' = ANY(NEW."acceptedPaymentModes")) THEN RETURN NEW; END IF;`,
    );
    await runner.query(sync);
    await runner.query(capacity);
    await runner.query(publication);
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error(
        'Preserve cumulative cash debt history; use a reviewed forward migration.',
      ),
    );
  }
}
