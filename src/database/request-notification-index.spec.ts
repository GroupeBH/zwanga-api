import { IndexRequestNotificationRetirement1780000099000 } from './migrations/1780000099000-IndexRequestNotificationRetirement';
import { databaseMigrations } from './migrations';
import { RequestResponsePhases1780000098000 } from './migrations/1780000098000-RequestResponsePhases';

describe('request notification retirement index migration', () => {
  const setup = (outerTransaction = false) => {
    const runner = {
      isTransactionActive: outerTransaction,
      startTransaction: jest.fn(async () => { runner.isTransactionActive = true; }),
      commitTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
      rollbackTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
      query: jest.fn(async (sql: string, _parameters?: unknown[]) => {
        if (sql.includes('current_setting')) return [{ lock_timeout: '11s', statement_timeout: '42s' }];
        if (sql.includes('pg_index')) return [{ indisvalid: true }];
        return [];
      }),
    };
    return { runner, migration: new IndexRequestNotificationRetirement1780000099000() };
  };

  it('is registered after the existing queue migrations', () => {
    expect(databaseMigrations).toContain(IndexRequestNotificationRetirement1780000099000);
    expect(databaseMigrations.indexOf(IndexRequestNotificationRetirement1780000099000))
      .toBeGreaterThan(databaseMigrations.indexOf(RequestResponsePhases1780000098000));
  });
  it.each([false, true])('respects the migration transaction and restores its budgets (outer=%s)', async outer => {
    const { runner, migration } = setup(outer);
    await migration.up(runner as never);
    expect(runner.startTransaction).toHaveBeenCalledTimes(outer ? 0 : 1);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(outer ? 0 : 1);
    expect(runner.query).toHaveBeenLastCalledWith(expect.stringContaining('set_config'), ['11s', '42s']);
    expect(runner.query).toHaveBeenCalledWith(expect.stringContaining('CREATE INDEX IF NOT EXISTS'));
    expect(runner.query.mock.calls.some(([sql]) => sql.includes('CONCURRENTLY'))).toBe(false);
  });
  it('rolls back a failed build without silently continuing', async () => {
    const { runner, migration } = setup();
    const query = runner.query.getMockImplementation()!;
    runner.query.mockImplementation(async (sql, args) => {
      if (sql.startsWith('CREATE INDEX')) throw new Error('synthetic lock timeout');
      return query(sql, args);
    });
    await expect(migration.up(runner as never)).rejects.toThrow('synthetic lock timeout');
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).not.toHaveBeenCalled();
  });
  it('rejects an invalid pre-existing index and leaves its repair to the operator', async () => {
    const { runner, migration } = setup(true);
    const query = runner.query.getMockImplementation()!;
    runner.query.mockImplementation(async (sql, args) => sql.includes('pg_index') ? [{ indisvalid: false }] : query(sql, args));
    await expect(migration.up(runner as never)).rejects.toThrow('is not valid');
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    expect(runner.query.mock.calls.some(([sql]) => sql.startsWith('DROP INDEX'))).toBe(false);
  });
  it('reverts only its own index, without removing notifications', async () => {
    const { runner, migration } = setup();
    await migration.down(runner as never);
    expect(runner.query).toHaveBeenCalledWith('DROP INDEX IF EXISTS "IDX_notifications_active_request_type"');
    expect(runner.query.mock.calls.some(([sql]) => /DELETE|TRUNCATE|DROP TABLE/.test(sql))).toBe(false);
  });
});
