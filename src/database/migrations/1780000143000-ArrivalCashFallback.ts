import { MigrationInterface, QueryRunner } from 'typeorm';

/** A paid ride is never reopened; only the published-mode guard is relaxed. */
export class ArrivalCashFallback1780000143000 implements MigrationInterface {
  name = 'ArrivalCashFallback1780000143000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Arrival cash fallback requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    const result: unknown = await runner.query(
      "SELECT pg_get_functiondef('zwanga_booking_cash_guard()'::regprocedure) AS definition",
    );
    const row: unknown = Array.isArray(result) ? result[0] : undefined;
    const definition =
      row && typeof row === 'object' && 'definition' in row
        ? row.definition
        : undefined;
    const before = `IF validate_mode AND COALESCE(NEW."paymentAmount",0) > 0 AND NOT (NEW."paymentMode" = ANY(t."acceptedPaymentModes")) THEN RAISE EXCEPTION 'TRIP_PAYMENT_MODE_UNAVAILABLE'; END IF;`;
    const after = `-- Arrival-only cash fallback: keep publication, booking and commission rules intact.
      IF TG_OP = 'UPDATE' AND OLD."paymentMode" IN ('electronic','points') AND NEW."paymentMode" = 'cash'
        AND OLD.status = 'completed' AND NEW.status = 'completed'
        AND COALESCE(OLD."droppedOff",false) AND COALESCE(NEW."droppedOff",false)
        AND OLD."tripId" = NEW."tripId"
        AND COALESCE(OLD."paymentStatus",'pending') <> 'succeeded'
        AND NEW."paymentStatus" = 'not_required'
        AND OLD."cashReceivedAt" IS NULL AND NEW."cashReceivedAt" IS NULL
        AND OLD."mixedPaymentAt" IS NULL AND NEW."mixedPaymentAt" IS NULL
      THEN validate_mode := false; END IF;
      ${before}`;
    if (
      typeof definition !== 'string' ||
      definition.split(before).length !== 2 ||
      definition.includes('Arrival-only cash fallback')
    ) {
      throw new Error(
        'Unexpected cash guard; refusing to replace financial safeguards',
      );
    }
    // CREATE OR REPLACE preserves the trigger and every existing financial check.
    // No rows are rewritten; wallet/commission lock ordering is unchanged.
    await runner.query(definition.replace(before, after));
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error(
        'Preserve accepted cash settlements; use a reviewed forward migration.',
      ),
    );
  }
}
