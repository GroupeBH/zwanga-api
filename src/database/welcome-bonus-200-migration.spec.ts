import { QueryRunner } from 'typeorm';
import { AddVerifiedWelcomeBonus1780000052000 } from './migrations/1780000052000-AddVerifiedWelcomeBonus';
import { DriverWelcomeBonusCopy1780000059000 } from './migrations/1780000059000-DriverWelcomeBonusCopy';
import { IsolateWelcomeBonusFailures1780000063000 } from './migrations/1780000063000-IsolateWelcomeBonusFailures';
import { WelcomeBonus25CdfCopy1780000071000 } from './migrations/1780000071000-WelcomeBonus25CdfCopy';
import { WelcomeBonus200Tokens1780000072000 } from './migrations/1780000072000-WelcomeBonus200Tokens';

async function fixture() {
  let definition = '';
  const query = jest.fn(async (sql: string) => {
    if (sql.startsWith('SELECT pg_get_functiondef')) return [{ definition }];
    if (/CREATE (OR REPLACE )?FUNCTION zwanga_grant_welcome_bonus/.test(sql)) {
      definition = sql
        .split('CREATE FUNCTION zwanga_welcome_bonus_on_validation')[0]
        .trim()
        .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
    }
    return [];
  });
  const runner = { isTransactionActive: true, query } as unknown as QueryRunner;
  for (const migration of [
    new AddVerifiedWelcomeBonus1780000052000(),
    new DriverWelcomeBonusCopy1780000059000(),
    new IsolateWelcomeBonusFailures1780000063000(),
    new WelcomeBonus25CdfCopy1780000071000(),
  ])
    await migration.up(runner);
  query.mockClear();
  return {
    runner,
    query,
    definition: () => definition,
    setDefinition: (value: string) => {
      definition = value;
    },
  };
}

describe('future 200-token welcome bonus migration', () => {
  const migration = new WelcomeBonus200Tokens1780000072000();

  it('changes new credits and copy together, preserves recovery amounts and eligibility', async () => {
    const f = await fixture();
    await migration.up(f.runner);
    const sql = f.definition();
    expect(sql).toContain('balance = balance + 200');
    expect(sql).toContain("'loyalty_reward',200,0,credited,a.currency");
    expect(sql).toContain("'amount',200,'currency',a.currency");
    expect(sql).toContain('VALUES (uid,k.id,ledger_id,legacy_amount)');
    expect(sql).toContain('VALUES (uid,k.id,ledger_id,200)');
    expect(sql).toContain('SELECT id, amount INTO ledger_id, legacy_amount');
    expect(sql).toContain(
      '5 000 FC vous sont offerts sous forme de 200 jetons',
    );
    expect(sql).toContain('200 jetons de bienvenue');
    expect(sql).toContain('FOR NO KEY UPDATE');
    expect(sql).toContain("k.status <> 'approved'");
    expect(sql).toContain("u.status <> 'active'");
    expect(sql).toContain("a.currency NOT IN ('PTS','POINTS')");
    expect(sql).toContain('ON CONFLICT ("eventKey") DO NOTHING');
    expect(f.query).toHaveBeenCalledWith(
      expect.stringContaining('CHECK (amount IN (50, 200)) NOT VALID'),
    );
    expect(
      f.query.mock.calls.some(([q]) =>
        /^(UPDATE|INSERT|DELETE|SELECT zwanga_)/.test(q.trim()),
      ),
    ).toBe(false);
  });

  it.each(['', 'custom function', 'duplicate amount'])(
    'rejects unexpected definitions before DDL: %s',
    async (kind) => {
      const f = await fixture();
      f.setDefinition(
        kind === 'duplicate amount'
          ? f.definition() + ' balance = balance + 50'
          : kind,
      );
      await expect(migration.up(f.runner)).rejects.toThrow(
        'Unexpected welcome bonus',
      );
      expect(
        f.query.mock.calls.some(([q]) => /^(ALTER|CREATE)/.test(q.trim())),
      ).toBe(false);
    },
  );

  it('requires a transaction and refuses reversal of financial history', async () => {
    const f = await fixture();
    f.runner.isTransactionActive = false;
    await expect(migration.up(f.runner)).rejects.toThrow(
      'requires a transaction',
    );
    expect(f.query).not.toHaveBeenCalled();
    await expect(migration.down()).rejects.toThrow('forward migration');
  });
});
