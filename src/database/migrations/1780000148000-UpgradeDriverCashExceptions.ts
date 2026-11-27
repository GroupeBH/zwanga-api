import { MigrationInterface, QueryRunner } from 'typeorm';
import { driverCashExceptionsSql } from './sql/driver-cash-exceptions';

const archive = 'driver_cash_exceptions_legacy_1780000148000';

/** Repair databases that recorded the earlier, per-booking revision of 145000.
 * Never replay that migration, rewrite receipts, collect money, or enable rollout.
 * Ambiguous historical penalties require explicit reconciliation, not guesswork.
 */
export class UpgradeDriverCashExceptions1780000148000 implements MigrationInterface {
  name = 'UpgradeDriverCashExceptions1780000148000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Cash upgrade requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    await runner.query(
      "SELECT pg_advisory_xact_lock(hashtext('zwanga-cash-exceptions-upgrade'))",
    );
    // Quiesce receipt/credit/admission writers while the tables and functions change.
    // Reads remain available except during the short authorization-table rename.
    await runner.query(`LOCK TABLE users, trips, bookings, trip_requests, driver_offers,
      wallet_accounts, wallet_ledger_entries, driver_cash_exceptions, driver_cash_restrictions
      IN SHARE ROW EXCLUSIVE MODE`);
    const [shape] = (await runner.query(`SELECT
      to_regclass('driver_cash_exception_trips') IS NOT NULL AS trips,
      to_regclass('driver_cash_exception_rollout') IS NOT NULL AS rollout,
      to_regclass('${archive}') IS NOT NULL AS archive,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='driver_cash_exceptions' AND column_name='occurrence') AS legacy,
      pg_get_functiondef('zwanga_booking_cash_guard()'::regprocedure) AS guard`)) as {
      trips: boolean;
      rollout: boolean;
      archive: boolean;
      legacy: boolean;
      guard: string;
    }[];
    if (
      !shape.guard.includes('zwanga_cash_exception_authorize') ||
      !shape.guard.includes('Arrival-only cash fallback') ||
      shape.trips !== shape.rollout ||
      (shape.trips && shape.legacy) ||
      (!shape.trips && (!shape.legacy || shape.archive))
    ) {
      throw new Error('CASH_UPGRADE_UNEXPECTED_SCHEMA');
    }

    if (!shape.trips) {
      // One old confirmed booking per trip can be copied losslessly. Never collapse
      // duplicate fines or renumber a driver's historical occurrences automatically.
      const [history] = (await runner.query(`SELECT
        EXISTS(SELECT 1 FROM driver_cash_exceptions WHERE "confirmedAt" IS NOT NULL
          GROUP BY "tripId" HAVING count(*)>1) AS duplicate,
        EXISTS(SELECT 1 FROM (
          SELECT occurrence, row_number() OVER(PARTITION BY "driverId" ORDER BY occurrence) AS expected
          FROM driver_cash_exceptions WHERE "confirmedAt" IS NOT NULL
        ) x WHERE occurrence IS DISTINCT FROM expected) AS gaps,
        EXISTS(SELECT 1 FROM driver_cash_exceptions e JOIN bookings b ON b.id=e."bookingId"
          JOIN trips t ON t.id=e."tripId" WHERE b."tripId"<>e."tripId" OR t."driverId"<>e."driverId"
          OR (e."confirmedAt" IS NOT NULL AND b."cashReceivedAt" IS NULL)
          OR (e."confirmedAt" IS NULL AND (e.occurrence IS NOT NULL OR e."penaltyAmount"<>0
            OR e."chargedTokens"<>0 OR e."chargedWithdrawableTokens"<>0))) AS inconsistent,
        EXISTS(SELECT 1 FROM pg_constraint WHERE contype='f'
          AND confrelid='driver_cash_exceptions'::regclass) AS dependants`)) as Record<
        string,
        boolean
      >[];
      if (Object.values(history).some(Boolean))
        throw new Error('CASH_UPGRADE_RECONCILIATION_REQUIRED');

      // Keep the full original schema/data as an audit archive. Recreate the small
      // authorization table so its old confirmedAt/occurrence check cannot reject
      // new per-trip receipts. No historical ledger reference is changed.
      const indexes =
        (await runner.query(`SELECT c.relname AS name FROM pg_index i
        JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='driver_cash_exceptions'::regclass
        ORDER BY c.relname`)) as { name: string }[];
      await runner.query(
        `ALTER TABLE driver_cash_exceptions RENAME TO ${archive}`,
      );
      for (const [i, index] of indexes.entries()) {
        const quoted = String(index.name).replace(/"/g, '""');
        await runner.query(
          `ALTER INDEX "${quoted}" RENAME TO "cash_legacy_1780000148000_${i}"`,
        );
      }
      const authorizationSql = this.section(
        'CREATE TABLE driver_cash_exceptions (',
        '-- One immutable incident',
      );
      const tripsSql = this.section(
        'CREATE TABLE driver_cash_exception_trips (',
        'CREATE TABLE driver_cash_restrictions (',
      );
      const rolloutSql = this.section(
        'CREATE TABLE driver_cash_exception_rollout (',
        'CREATE TABLE driver_cash_exceptions (',
      );
      await runner.query(authorizationSql + tripsSql + rolloutSql);
      await runner.query(`INSERT INTO driver_cash_exceptions
        ("bookingId","driverId","tripId","authorizedAt","confirmedAt")
        SELECT "bookingId","driverId","tripId","authorizedAt","confirmedAt" FROM ${archive}`);
      await runner.query(`INSERT INTO driver_cash_exception_trips
        ("tripId","driverId","firstBookingId","confirmedAt",occurrence,"penaltyAmount",
         "moneyPerToken","chargedTokens","chargedWithdrawableTokens")
        SELECT "tripId","driverId","bookingId","confirmedAt",occurrence,"penaltyAmount",
          "moneyPerToken","chargedTokens","chargedWithdrawableTokens"
        FROM ${archive} WHERE "confirmedAt" IS NOT NULL`);
    }

    // Reuse the checked-in v2 definitions, not a replay of its table/trigger DDL.
    // A fresh v2 database also takes this path, retaining its release flag/history.
    const functions = [
      ...driverCashExceptionsSql.matchAll(
        /CREATE FUNCTION (zwanga_cash_\w+)\([\s\S]*?END \$\$;/g,
      ),
    ];
    const expected = [
      'zwanga_cash_exception_authorize',
      'zwanga_cash_exception_collect',
      'zwanga_cash_exception_credit',
      'zwanga_cash_exception_receipt',
      'zwanga_cash_exception_release',
      'zwanga_cash_restricted_admission',
    ];
    if (
      functions.length !== expected.length ||
      functions.some((f, i) => f[1] !== expected[i])
    ) {
      throw new Error('CASH_UPGRADE_FUNCTION_DEFINITIONS_CHANGED');
    }
    for (const [definition] of functions) {
      await runner.query(
        definition.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'),
      );
    }
    // All triggers already belong to bookings/wallet/admission tables, not the
    // archived authorizations. Fail closed if any old installation is incomplete.
    const [triggers] =
      (await runner.query(`SELECT count(*)::int AS count FROM pg_trigger t
      JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND t.tgenabled='O'
      AND (t.tgname,t.tgrelid,p.proname) IN (
        ('zz_cash_exception_credit','wallet_ledger_entries'::regclass,'zwanga_cash_exception_credit'),
        ('cash_exception_receipt','bookings'::regclass,'zwanga_cash_exception_receipt'),
        ('cash_exception_release','bookings'::regclass,'zwanga_cash_exception_release'),
        ('cash_restricted_admission','trips'::regclass,'zwanga_cash_restricted_admission'),
        ('cash_restricted_admission','bookings'::regclass,'zwanga_cash_restricted_admission'),
        ('cash_restricted_admission','trip_requests'::regclass,'zwanga_cash_restricted_admission'),
        ('cash_restricted_admission','driver_offers'::regclass,'zwanga_cash_restricted_admission'))`)) as {
        count: number;
      }[];
    if (triggers.count !== 7) throw new Error('CASH_UPGRADE_TRIGGER_MISMATCH');
  }

  private section(start: string, end: string): string {
    const pieces = driverCashExceptionsSql.split(start);
    if (pieces.length !== 2 || pieces[1].split(end).length !== 2) {
      throw new Error('CASH_UPGRADE_SCHEMA_DEFINITIONS_CHANGED');
    }
    return start + pieces[1].split(end)[0];
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error('Preserve cash history; use a reviewed forward migration.'),
    );
  }
}
