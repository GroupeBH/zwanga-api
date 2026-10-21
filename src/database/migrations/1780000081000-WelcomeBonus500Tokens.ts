import { MigrationInterface, QueryRunner } from 'typeorm';

/** Future grants only. Historical 50/200-token claims are not topped up. */
export class WelcomeBonus500Tokens1780000081000 implements MigrationInterface {
  name = 'WelcomeBonus500Tokens1780000081000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Welcome bonus amount migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");
    const [row] = await runner.query(
      "SELECT pg_get_functiondef('zwanga_grant_welcome_bonus(uuid)'::regprocedure) AS definition",
    );
    if (typeof row?.definition !== 'string')
      throw new Error('Missing welcome bonus function definition');
    let definition: string = row.definition;
    const replace = (previous: string, next: string) => {
      if (definition.split(previous).length !== 2)
        throw new Error('Unexpected welcome bonus definition; refusing amount change');
      definition = definition.replace(previous, next);
    };
    replace('VALUES (uid,k.id,ledger_id,200)', 'VALUES (uid,k.id,ledger_id,500)');
    replace('balance = balance + 200', 'balance = balance + 500');
    replace("'loyalty_reward',200,0,credited,a.currency", "'loyalty_reward',500,0,credited,a.currency");
    replace("'amount',200,'currency',a.currency", "'amount',500,'currency',a.currency");
    replace(
      'Bienvenue chez Zwanga ! 5 000 FC vous sont offerts sous forme de 200 jetons Zwanga pour vous permettre de payer votre abonnement Pro.',
      'Bienvenue chez Zwanga ! 5 000 FC vous sont offerts sous forme de 500 jetons Zwanga pour vous permettre de payer votre abonnement Pro.',
    );
    replace(
      'Votre identité et votre compte sont validés. 200 jetons de bienvenue ont été ajoutés à votre portefeuille.',
      'Votre identité et votre compte sont validés. 500 jetons de bienvenue ont été ajoutés à votre portefeuille.',
    );
    // No historical grants, balances, notifications or financial ledger rewrites.
    await runner.query(`ALTER TABLE welcome_bonus_grants
      DROP CONSTRAINT welcome_bonus_grants_amount_check,
      ADD CONSTRAINT welcome_bonus_grants_amount_check CHECK (amount IN (50, 200, 500)) NOT VALID,
      ALTER COLUMN amount SET DEFAULT 500`);
    await runner.query(definition);
  }

  down(): Promise<void> {
    return Promise.reject(new Error(
      'Use a forward migration; existing 50/200/500-token welcome grants must remain unchanged.',
    ));
  }
}
