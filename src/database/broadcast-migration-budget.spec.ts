import { QueryRunner } from 'typeorm';
import { BroadcastDriverRequests1780000074000 } from './migrations/1780000074000-BroadcastDriverRequests';

describe('broadcast migration DDL budgets', () => {
  const fixture = (outerTransaction: boolean, failDdl = false) => {
    const runner = {
      isTransactionActive: outerTransaction,
      startTransaction: jest.fn(async () => { runner.isTransactionActive = true; }),
      commitTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
      rollbackTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
      query: jest.fn(async (sql: string, _args?: unknown[]) => {
        if (sql.includes('current_setting')) return [{ lock_timeout: '0', statement_timeout: '30s' }];
        if (failDdl && sql.startsWith('DROP INDEX')) throw new Error('lock timeout');
        return [];
      }),
    };
    return runner;
  };

  it.each([false, true])('restores prior settings and respects transaction ownership (outer=%s)', async outer => {
    const runner = fixture(outer);
    await new BroadcastDriverRequests1780000074000().up(runner as unknown as QueryRunner);
    expect(runner.query.mock.calls[1][0]).toContain("set_config('lock_timeout', '3s', true)");
    expect(runner.query.mock.calls[1][0]).toContain("set_config('statement_timeout', '15s', true)");
    expect(runner.query).toHaveBeenLastCalledWith(expect.stringContaining('set_config'), ['0', '30s']);
    expect(runner.startTransaction).toHaveBeenCalledTimes(outer ? 0 : 1);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(outer ? 0 : 1);
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    expect(runner.isTransactionActive).toBe(outer);
  });

  it.each([false, true])('propagates DDL failures and rolls back only its own transaction (outer=%s)', async outer => {
    const runner = fixture(outer, true);
    await expect(new BroadcastDriverRequests1780000074000().up(runner as unknown as QueryRunner)).rejects.toThrow('lock timeout');
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(outer ? 0 : 1);
  });
});
