import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SequentialRequestQueue1780000097000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query('ALTER TABLE trip_requests ADD COLUMN "sequentialDispatch" boolean NOT NULL DEFAULT false');
    await runner.query('ALTER TABLE trip_request_dispatch_offers ADD COLUMN sequential boolean NOT NULL DEFAULT false');
    await runner.query(`CREATE UNIQUE INDEX dispatch_one_sequential_pending_request_idx
      ON trip_request_dispatch_offers ("requestId") WHERE sequential = true AND status = 'pending'`);
    // During a rolling deployment, an older allocator must not bypass the invariant.
    await runner.query(`CREATE FUNCTION enforce_sequential_request_offer() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF EXISTS (SELECT 1 FROM trip_requests WHERE id = NEW."requestId" AND "sequentialDispatch" = true) THEN
          NEW.sequential := true;
          NEW."expiresAt" := LEAST(NEW."expiresAt", clock_timestamp() + interval '40 seconds');
        END IF;
        RETURN NEW;
      END; $body$`);
    await runner.query(`CREATE TRIGGER enforce_sequential_request_offer BEFORE INSERT ON trip_request_dispatch_offers
      FOR EACH ROW EXECUTE FUNCTION enforce_sequential_request_offer()`);
  }
  async down(runner: QueryRunner) {
    const [row] = await runner.query(`SELECT count(*)::int AS count FROM trip_request_dispatch_offers WHERE sequential = true AND status = 'pending'`);
    if (row.count) throw new Error('Live sequential invitations must finish before rollback.');
    await runner.query('DROP TRIGGER enforce_sequential_request_offer ON trip_request_dispatch_offers');
    await runner.query('DROP FUNCTION enforce_sequential_request_offer()');
    await runner.query('DROP INDEX dispatch_one_sequential_pending_request_idx');
    await runner.query('ALTER TABLE trip_request_dispatch_offers DROP COLUMN sequential');
    await runner.query('ALTER TABLE trip_requests DROP COLUMN "sequentialDispatch"');
  }
}
