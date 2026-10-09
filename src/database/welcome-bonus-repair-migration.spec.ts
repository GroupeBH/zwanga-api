import { QueryRunner } from 'typeorm';
import { AddVerifiedWelcomeBonus1780000052000 } from './migrations/1780000052000-AddVerifiedWelcomeBonus';
import { IsolateWelcomeBonusFailures1780000063000 } from './migrations/1780000063000-IsolateWelcomeBonusFailures';
import { AddPinResetReplayProtection1780000064000 } from './migrations/1780000064000-AddPinResetReplayProtection';
import { databaseMigrations } from './migrations';

async function fixture() {
  const originalQueries: string[] = [];
  await new AddVerifiedWelcomeBonus1780000052000().up({
    query: async (sql: string) => {
      originalQueries.push(sql);
    },
  } as unknown as QueryRunner);
  let definition = originalQueries
    .find((sql) => sql.includes('CREATE FUNCTION zwanga_grant_welcome_bonus'))!
    .split('CREATE FUNCTION zwanga_welcome_bonus_on_validation')[0]
    .trim()
    .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
  const original = definition;
  const query = jest.fn(async (sql: string) => {
    if (sql.startsWith('SELECT pg_get_functiondef')) return [{ definition }];
    if (sql.startsWith('CREATE OR REPLACE FUNCTION zwanga_grant_welcome_bonus'))
      definition = sql;
    return [];
  });
  return {
    runner: { isTransactionActive: true, query } as unknown as QueryRunner,
    query,
    original,
    definition: () => definition,
  };
}

describe('welcome bonus repair migrations', () => {
  const repair = new IsolateWelcomeBonusFailures1780000063000();
  const replay = new AddPinResetReplayProtection1780000064000();

  it('registers both forward repairs after the existing migrations', () => {
    expect(databaseMigrations.slice(-2)).toEqual([
      IsolateWelcomeBonusFailures1780000063000,
      AddPinResetReplayProtection1780000064000,
    ]);
  });

  it('preserves the grant except for supported currency aliases and remains repeatable', async () => {
    const f = await fixture();
    await repair.up(f.runner);
    expect(f.definition()).toBe(
      f.original
        .replace(
          "IF a.currency <> 'PTS' THEN",
          "IF a.currency IS NULL OR a.currency NOT IN ('PTS','POINTS') THEN",
        )
        .replace(
          "credited,'PTS','welcome_bonus'",
          "credited,a.currency,'welcome_bonus'",
        )
        .replace(
          "'amount',50,'currency','PTS'",
          "'amount',50,'currency',a.currency",
        ),
    );
    const first = f.definition();
    await repair.up(f.runner);
    expect(f.definition()).toBe(first);
    expect(
      f.query.mock.calls.some(([sql]) =>
        /^(UPDATE|DELETE|INSERT|SELECT zwanga_)/.test(sql.trim()),
      ),
    ).toBe(false);
  });

  it('refuses an unexpected deployed function before changing anything', async () => {
    const f = await fixture();
    f.query.mockImplementation(async (sql) =>
      sql.startsWith('SELECT pg_get_functiondef')
        ? [{ definition: 'unexpected' }]
        : [],
    );
    await expect(repair.up(f.runner)).rejects.toThrow(
      'Unexpected welcome bonus definition',
    );
    expect(f.query.mock.calls.some(([sql]) => /CREATE|ALTER/.test(sql))).toBe(
      false,
    );
  });

  it.each([repair, replay])(
    'requires a transaction and rejects unsafe rollback (%s)',
    async (migration) => {
      const f = await fixture();
      f.runner.isTransactionActive = false;
      await expect(migration.up(f.runner)).rejects.toThrow(
        'requires a transaction',
      );
      expect(f.query).not.toHaveBeenCalled();
      await expect(migration.down()).rejects.toThrow('forward migration');
    },
  );
});
