import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive; the existing receipt/ride indexes remain usable by older versions. */
export class CashDeclarationRealtimeIndex1780000116000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await this.bounded(runner, async () => {
      await runner.query(`CREATE INDEX IF NOT EXISTS "IDX_notifications_cash_declaration_realtime"
        ON notifications ("createdAt", id) WHERE "eventKey" IS NOT NULL AND "isActive" = true
        AND data ->> 'type' = 'cash_payment_declared' AND data ->> 'role' = 'driver'`);
      const [index] = (await runner.query(`SELECT indisvalid FROM pg_index
        WHERE indexrelid=to_regclass('"IDX_notifications_cash_declaration_realtime"')`)) as {
        indisvalid: boolean;
      }[];
      if (!index?.indisvalid)
        throw new Error('Cash declaration realtime index is not valid');
    });
  }
  async down(runner: QueryRunner): Promise<void> {
    await this.bounded(runner, () =>
      runner.query(
        'DROP INDEX IF EXISTS "IDX_notifications_cash_declaration_realtime"',
      ),
    );
  }
  private async bounded(
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
        "SELECT set_config('lock_timeout','3s',true), set_config('statement_timeout','30s',true)",
      );
      await work();
      await runner.query(
        "SELECT set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true)",
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
