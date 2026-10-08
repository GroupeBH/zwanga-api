import { QueryRunner } from 'typeorm';
import { DriverWelcomeBonusCopy1780000059000 } from './migrations/1780000059000-DriverWelcomeBonusCopy';

const legacyCopy =
  "'Votre identité et votre compte sont validés. 50 jetons de bienvenue ont été ajoutés à votre portefeuille.'";
const original = `CREATE OR REPLACE FUNCTION zwanga_grant_welcome_bonus(uid uuid)
RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
  -- Existing credit, eligibility and locking logic must remain untouched.
  INSERT INTO notifications(body) VALUES (${legacyCopy});
  RETURN true;
END $$;`;

function fixture(initial = original) {
  let definition = initial;
  const query = jest.fn(async (sql: string) => {
    if (sql.startsWith('SELECT pg_get_functiondef')) return [{ definition }];
    if (sql.startsWith('CREATE OR REPLACE FUNCTION')) definition = sql;
    return [];
  });
  const runner = { isTransactionActive: true, query } as unknown as QueryRunner;
  return { runner, query, definition: () => definition };
}

describe('driver welcome bonus notification-only migration', () => {
  const migration = new DriverWelcomeBonusCopy1780000059000();

  it('replaces only the text expression and is reversible/idempotent without issuing credits', async () => {
    const f = fixture();
    await migration.up(f.runner);
    const expected = original.replace(
      legacyCopy,
      "CASE WHEN u.role = 'driver' THEN 'Bienvenue chez Zwanga ! 5 000 FC vous sont offerts sous forme de jetons Zwanga pour vous permettre de payer votre abonnement Pro.' ELSE " +
        legacyCopy +
        ' END',
    );
    expect(f.definition()).toBe(expected);
    await migration.up(f.runner);
    expect(f.definition()).toBe(expected);
    await migration.down(f.runner);
    expect(f.definition()).toBe(original);
    await migration.down(f.runner);
    expect(f.definition()).toBe(original);
    expect(
      f.query.mock.calls.filter(([sql]) =>
        sql.startsWith('CREATE OR REPLACE FUNCTION'),
      ),
    ).toHaveLength(2);
    expect(
      f.query.mock.calls.some(([sql]) =>
        /^(INSERT|UPDATE|DELETE|SELECT zwanga_grant)/.test(sql),
      ),
    ).toBe(false);
  });

  it.each([
    'unknown function body',
    original.replace(legacyCopy, legacyCopy + ', ' + legacyCopy),
  ])(
    'refuses an unexpected/ambiguous body instead of rewriting financial logic',
    async (definition) => {
      const f = fixture(definition);
      await expect(migration.up(f.runner)).rejects.toThrow(
        'Unexpected welcome bonus',
      );
      expect(
        f.query.mock.calls.some(([sql]) =>
          sql.startsWith('CREATE OR REPLACE FUNCTION'),
        ),
      ).toBe(false);
    },
  );

  it('requires a transaction before accessing the database', async () => {
    const f = fixture();
    f.runner.isTransactionActive = false;
    await expect(migration.up(f.runner)).rejects.toThrow(
      'requires a transaction',
    );
    expect(f.query).not.toHaveBeenCalled();
  });
});
