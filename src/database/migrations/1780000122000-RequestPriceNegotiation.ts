import { MigrationInterface, QueryRunner } from 'typeorm';

export class RequestPriceNegotiation1780000122000 implements MigrationInterface {
  name = 'RequestPriceNegotiation1780000122000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await this.withBudget(queryRunner, () =>
      queryRunner.query(`ALTER TABLE driver_offers
      ADD COLUMN "negotiationStage" varchar(24), ADD COLUMN "previousOfferId" uuid,
      ADD CONSTRAINT "CHK_driver_offer_negotiation_stage" CHECK
        ("negotiationStage" IS NULL OR "negotiationStage" IN ('driver_initial','passenger_counter','driver_final'))`),
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await this.withBudget(queryRunner, async () => {
      await queryRunner.query(
        'LOCK TABLE driver_offers IN ACCESS EXCLUSIVE MODE',
      );
      // Losing pending negotiation state could let an old client accept its own counter-offer.
      const pending = (await queryRunner.query(
        `SELECT 1 FROM driver_offers WHERE status='pending' AND "negotiationStage" IS NOT NULL LIMIT 1`,
      )) as unknown[];
      if (pending.length)
        throw new Error(
          'Finish or cancel pending price negotiations before rolling back.',
        );
      await queryRunner.query(`ALTER TABLE driver_offers DROP CONSTRAINT "CHK_driver_offer_negotiation_stage",
      DROP COLUMN "previousOfferId", DROP COLUMN "negotiationStage"`);
    });
  }
  private async withBudget(
    runner: QueryRunner,
    work: () => Promise<unknown>,
  ): Promise<void> {
    const ownsTransaction = !runner.isTransactionActive;
    if (ownsTransaction) await runner.startTransaction();
    try {
      const [previous] =
        (await runner.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
        current_setting('statement_timeout') AS statement_timeout`)) as {
          lock_timeout: string;
          statement_timeout: string;
        }[];
      await runner.query(
        "SELECT set_config('lock_timeout', '3s', true), set_config('statement_timeout', '15s', true)",
      );
      await work();
      await runner.query(
        "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
        [previous.lock_timeout, previous.statement_timeout],
      );
      if (ownsTransaction) await runner.commitTransaction();
    } catch (error) {
      if (ownsTransaction && runner.isTransactionActive)
        await runner.rollbackTransaction();
      throw error;
    }
  }
}
