import { MigrationInterface, QueryRunner } from 'typeorm';

// This migration changes notification copy only. Keep these literals immutable:
// already-applied migrations must not depend on future application wording.
const LEGACY_COPY =
  "'Votre identité et votre compte sont validés. 50 jetons de bienvenue ont été ajoutés à votre portefeuille.'";
const DRIVER_COPY =
  "CASE WHEN u.role = 'driver' THEN 'Bienvenue chez Zwanga ! 5 000 FC vous sont offerts sous forme de jetons Zwanga pour vous permettre de payer votre abonnement Pro.' ELSE " +
  LEGACY_COPY +
  ' END';

export class DriverWelcomeBonusCopy1780000059000 implements MigrationInterface {
  name = 'DriverWelcomeBonusCopy1780000059000';

  up(runner: QueryRunner): Promise<void> {
    return this.replaceCopy(runner, true);
  }

  down(runner: QueryRunner): Promise<void> {
    return this.replaceCopy(runner, false);
  }

  private async replaceCopy(
    runner: QueryRunner,
    driverCopy: boolean,
  ): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Welcome bonus copy migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    const [row] = await runner.query(
      "SELECT pg_get_functiondef('zwanga_grant_welcome_bonus(uuid)'::regprocedure) AS definition",
    );
    const definition: unknown = row?.definition;
    if (typeof definition !== 'string')
      throw new Error('Missing welcome bonus function definition');

    if (driverCopy && definition.includes(DRIVER_COPY)) return;
    if (
      !driverCopy &&
      !definition.includes(DRIVER_COPY) &&
      definition.split(LEGACY_COPY).length === 2
    )
      return;

    const previous = driverCopy ? LEGACY_COPY : DRIVER_COPY;
    const next = driverCopy ? DRIVER_COPY : LEGACY_COPY;
    if (definition.split(previous).length !== 2)
      throw new Error(
        'Unexpected welcome bonus notification copy; refusing to alter financial logic',
      );
    // Preserve all deployed eligibility, locks, amounts and idempotency logic.
    // No historical notification or ledger row is updated, and no grant is run.
    await runner.query(definition.replace(previous, next));
  }
}
