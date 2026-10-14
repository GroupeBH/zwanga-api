import { MigrationInterface, QueryRunner } from 'typeorm';

// This only corrects the promise attached to the unchanged 50-token grant.
// Existing notifications, balances, grant eligibility and deduplication stay intact.
const PREVIOUS =
  'Bienvenue chez Zwanga ! 5 000 FC vous sont offerts sous forme de jetons Zwanga pour vous permettre de payer votre abonnement Pro.';
const CURRENT =
  'Bienvenue chez Zwanga ! 1 250 FC vous sont offerts sous forme de 50 jetons Zwanga pour contribuer au paiement de votre abonnement Pro.';

export class WelcomeBonus25CdfCopy1780000071000 implements MigrationInterface {
  name = 'WelcomeBonus25CdfCopy1780000071000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Welcome copy migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    const [row] = await runner.query(
      "SELECT pg_get_functiondef('zwanga_grant_welcome_bonus(uuid)'::regprocedure) AS definition",
    );
    const definition: unknown = row?.definition;
    if (typeof definition !== 'string')
      throw new Error('Missing welcome bonus function');
    if (definition.includes(CURRENT) && !definition.includes(PREVIOUS)) return;
    if (definition.split(PREVIOUS).length !== 2)
      throw new Error(
        'Unexpected welcome bonus copy; refusing to change financial logic',
      );
    await runner.query(definition.replace(PREVIOUS, CURRENT));
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error(
        'Use a forward migration; do not restore a promise at an obsolete token value.',
      ),
    );
  }
}
