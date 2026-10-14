import { MigrationInterface, QueryRunner } from 'typeorm';

/** Future grants only: preserve all existing claims, balances and outbox rows. */
export class WelcomeBonus200Tokens1780000072000 implements MigrationInterface {
  name = 'WelcomeBonus200Tokens1780000072000';

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
    const replace = (previous: string, next: string, count = 1) => {
      if (definition.split(previous).length !== count + 1)
        throw new Error(
          'Unexpected welcome bonus definition; refusing amount change',
        );
      definition = definition.replace(previous, next);
    };
    replace(
      'ledger_id uuid; credited numeric(12,2);',
      'ledger_id uuid; credited numeric(12,2); legacy_amount numeric(12,2);',
    );
    replace(
      'SELECT id INTO ledger_id FROM wallet_ledger_entries',
      'SELECT id, amount INTO ledger_id, legacy_amount FROM wallet_ledger_entries',
    );
    const claim =
      'INSERT INTO welcome_bonus_grants ("userId","kycDocumentId","ledgerEntryId") VALUES (uid,k.id,ledger_id);';
    // The first claim is recovery of an already-paid ledger: record its ACTUAL
    // amount, never the new default. No credit or notification is issued there.
    replace(
      claim,
      'INSERT INTO welcome_bonus_grants ("userId","kycDocumentId","ledgerEntryId",amount) VALUES (uid,k.id,ledger_id,legacy_amount);',
      2,
    );
    replace(
      claim,
      'INSERT INTO welcome_bonus_grants ("userId","kycDocumentId","ledgerEntryId",amount) VALUES (uid,k.id,ledger_id,200);',
    );
    replace('balance = balance + 50', 'balance = balance + 200');
    replace(
      "'loyalty_reward',50,0,credited,a.currency",
      "'loyalty_reward',200,0,credited,a.currency",
    );
    replace(
      "'amount',50,'currency',a.currency",
      "'amount',200,'currency',a.currency",
    );
    replace(
      'Bienvenue chez Zwanga ! 1 250 FC vous sont offerts sous forme de 50 jetons Zwanga pour contribuer au paiement de votre abonnement Pro.',
      'Bienvenue chez Zwanga ! 5 000 FC vous sont offerts sous forme de 200 jetons Zwanga pour vous permettre de payer votre abonnement Pro.',
    );
    replace(
      'Votre identité et votre compte sont validés. 50 jetons de bienvenue ont été ajoutés à votre portefeuille.',
      'Votre identité et votre compte sont validés. 200 jetons de bienvenue ont été ajoutés à votre portefeuille.',
    );

    // The old validated check already restricts historical rows to 50. NOT VALID
    // avoids a scan under an exclusive lock; all subsequent writes are checked.
    // Validate the known function shape BEFORE changing any database definition.
    await runner.query(`ALTER TABLE welcome_bonus_grants
      DROP CONSTRAINT welcome_bonus_grants_amount_check,
      ADD CONSTRAINT welcome_bonus_grants_amount_check CHECK (amount IN (50, 200)) NOT VALID,
      ALTER COLUMN amount SET DEFAULT 200`);
    await runner.query(definition);
    // The existing deferred triggers and bounded backfill both call this function.
    // Do not run the grant/backfill or update historical financial rows here.
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error(
        'Use a forward migration; existing 50/200-token welcome grants must remain unchanged.',
      ),
    );
  }
}
