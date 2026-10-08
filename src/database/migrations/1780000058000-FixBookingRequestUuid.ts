import { MigrationInterface, QueryRunner } from 'typeorm';

export const bookingRequestUuidReplacements = [
  ['WHERE id = t."tripRequestId";', 'WHERE id = t."tripRequestId"::uuid;'],
  ['WHERE "requestId" = t."tripRequestId" AND', 'WHERE "requestId" = t."tripRequestId"::uuid AND'],
] as const;

/** Both lookup and dispatch-hold transfer use the legacy varchar trip link. */
export class FixBookingRequestUuid1780000058000 implements MigrationInterface {
  name = 'FixBookingRequestUuid1780000058000';
  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive) throw new Error('Booking UUID repair requires a transaction');
    await runner.query(`SET LOCAL lock_timeout = '5s'`);
    await runner.query(`SET LOCAL statement_timeout = '30s'`);
    const [row]: { definition: string }[] = await runner.query(
      'SELECT pg_get_functiondef($1::regprocedure) AS definition', ['zwanga_booking_cash_guard()']);
    let corrected = row?.definition;
    if (!corrected) throw new Error('Booking cash guard is missing');
    for (const [before, after] of bookingRequestUuidReplacements) {
      if (corrected.includes(after) && !corrected.includes(before)) continue;
      if (corrected.split(before).length !== 2) throw new Error('Unexpected booking cash guard; refusing policy overwrite');
      corrected = corrected.replace(before, after);
    }
    if (corrected !== row.definition) await runner.query(corrected);
  }
  down(): Promise<void> {
    return Promise.reject(new Error('Do not restore broken booking UUID comparisons; use a forward fix.'));
  }
}
