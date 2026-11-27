import { MigrationInterface, QueryRunner } from 'typeorm';
import { driverCashExceptionsSql } from './sql/driver-cash-exceptions';

/** Prospective per-booking authorization, one incident per trip. No past receipts rewritten. */
export class DriverCashExceptions1780000145000 implements MigrationInterface {
  name = 'DriverCashExceptions1780000145000';
  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Cash exceptions require a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    const rows = (await runner.query(
      "SELECT pg_get_functiondef('zwanga_booking_cash_guard()'::regprocedure) AS definition",
    )) as { definition: string }[];
    const original = rows[0]?.definition;
    const anchor =
      '  PERFORM zwanga_cash_sync(NEW.id,t."driverId",t.id,NEW."paymentAmount",NEW."cashCommissionTokenValue",next_state,require_funds,';
    if (
      !original?.includes('Arrival-only cash fallback') ||
      original.split(anchor).length !== 2 ||
      original.includes('zwanga_cash_exception_authorize')
    ) {
      throw new Error(
        'Unexpected cash guard; refusing to alter settlement protections',
      );
    }
    await runner.query(driverCashExceptionsSql);
    await runner.query(
      original.replace(
        anchor,
        `
  IF require_funds AND TG_OP='UPDATE' AND OLD."paymentMode" IN ('points','electronic')
    AND NEW."paymentMode"='cash' AND OLD.status='completed' AND NEW.status='completed'
    AND OLD."droppedOff" AND NEW."droppedOff" AND OLD."tripId"=NEW."tripId"
    AND COALESCE(OLD."paymentStatus",'pending')<>'succeeded' AND NEW."paymentStatus"='not_required'
    AND OLD."cashReceivedAt" IS NULL AND NEW."cashReceivedAt" IS NULL
    AND OLD."mixedPaymentAt" IS NULL AND NEW."mixedPaymentAt" IS NULL
    AND NEW."paymentCurrency"='CDF' AND NEW."paymentAmount">0 THEN
    IF zwanga_cash_exception_authorize(NEW.id,t."driverId",t.id,NEW."paymentAmount",NEW."cashCommissionTokenValue") THEN
      require_funds := false;
    END IF;
  END IF;
${anchor}`,
      ),
    );
  }
  down(): Promise<void> {
    return Promise.reject(
      new Error(
        'Preserve warnings, penalties and receipts; use a reviewed forward migration.',
      ),
    );
  }
}
