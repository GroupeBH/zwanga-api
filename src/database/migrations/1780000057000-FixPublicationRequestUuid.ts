import { MigrationInterface, QueryRunner } from 'typeorm';

/** Keep the installed financial policy intact; cast only the legacy varchar link. */
export class FixPublicationRequestUuid1780000057000 implements MigrationInterface {
  name = 'FixPublicationRequestUuid1780000057000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive) throw new Error('UUID guard repair requires a transaction');
    await runner.query(`SET LOCAL lock_timeout = '5s'`);
    await runner.query(`SET LOCAL statement_timeout = '30s'`);
    const [row]: { definition: string }[] = await runner.query(
      'SELECT pg_get_functiondef($1::regprocedure) AS definition',
      ['zwanga_publication_cash_guard()'],
    );
    const original = 'WHERE id = NEW."tripRequestId";';
    const corrected = 'WHERE id = NEW."tripRequestId"::uuid;';
    if (!row?.definition) throw new Error('Publication cash guard is missing');
    if (row.definition.includes(corrected) && !row.definition.includes(original)) return;
    if (row.definition.split(original).length !== 2)
      throw new Error('Unexpected publication cash guard; refusing to overwrite financial policy');
    await runner.query(row.definition.replace(original, corrected));
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Do not restore the broken UUID comparison; use a forward fix.'));
  }
}
