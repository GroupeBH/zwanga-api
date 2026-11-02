import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Only future INSERTs change; published invitation deadlines are immutable. */
export class DriverResponse75Seconds1780000107000 implements MigrationInterface {
  name = 'DriverResponse75Seconds1780000107000';
  async up(runner: QueryRunner) { await this.setLimit(runner, 75); }
  async down(runner: QueryRunner) { await this.setLimit(runner, 40); }

  private async setLimit(runner: QueryRunner, seconds: 40 | 75) {
    if (!runner.isTransactionActive) throw new Error('Response deadline migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    await runner.query(`CREATE OR REPLACE FUNCTION enforce_sequential_request_offer() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF EXISTS (SELECT 1 FROM trip_requests WHERE id = NEW."requestId" AND "sequentialDispatch" = true) THEN
          NEW.sequential := true;
          NEW."expiresAt" := LEAST(NEW."expiresAt", clock_timestamp() + interval '${seconds} seconds');
        END IF;
        RETURN NEW;
      END; $body$`);
  }
}
