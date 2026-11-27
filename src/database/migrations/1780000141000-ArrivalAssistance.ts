import { MigrationInterface, QueryRunner } from 'typeorm';

export class ArrivalAssistance1780000141000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive)
      throw Error('Arrival assistance migration requires a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query('ALTER TABLE bookings ADD COLUMN "arrivalPrompt" jsonb');
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE bookings DROP COLUMN "arrivalPrompt"');
  }
}
