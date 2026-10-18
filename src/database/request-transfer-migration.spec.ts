import type { QueryRunner } from 'typeorm';
import { IndexRequestsAndTransfers1780000075000 } from './migrations/1780000075000-IndexRequestsAndTransfers';

describe('request pagination and transfer replay indexes (DDL simulation)', () => {
  function fixture(outer: boolean, fail = false) {
    const runner = {
      isTransactionActive: outer,
      startTransaction: jest.fn(async () => { runner.isTransactionActive = true; }),
      commitTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
      rollbackTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
      query: jest.fn(async (sql: string, _parameters?: unknown[]) => {
        if (sql.includes('current_setting')) return [{ lock_timeout: '0', statement_timeout: '20s' }];
        if (fail && sql.startsWith('CREATE')) throw new Error('index budget exceeded');
        return [];
      }),
    };
    return runner;
  }
  it.each([false, true])('bounds DDL, restores budgets and respects outer transaction=%s', async outer => {
    const f = fixture(outer); await new IndexRequestsAndTransfers1780000075000().up(f as unknown as QueryRunner);
    expect(f.query.mock.calls[1][0]).toContain("set_config('lock_timeout', '5s', true)");
    expect(f.query.mock.calls[1][0]).toContain("set_config('statement_timeout', '30s', true)");
    const indexes = f.query.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith('CREATE'));
    expect(indexes).toHaveLength(4);
    expect(indexes.at(-1)).toContain('CREATE UNIQUE INDEX');
    expect(indexes.at(-1)).toContain("'transfer_out', 'transfer_in'");
    expect(f.query).toHaveBeenLastCalledWith(expect.stringContaining('set_config'), ['0', '20s']);
    expect(f.commitTransaction).toHaveBeenCalledTimes(outer ? 0 : 1);
    expect(f.isTransactionActive).toBe(outer);
  });
  it.each([false, true])('propagates failure without committing partial work (outer=%s)', async outer => {
    const f = fixture(outer, true);
    await expect(new IndexRequestsAndTransfers1780000075000().up(f as unknown as QueryRunner)).rejects.toThrow('index budget exceeded');
    expect(f.commitTransaction).not.toHaveBeenCalled();
    expect(f.rollbackTransaction).toHaveBeenCalledTimes(outer ? 0 : 1);
  });
  it('rollback removes only these indexes, never ledger entries or requests', async () => {
    const f = fixture(false); await new IndexRequestsAndTransfers1780000075000().down(f as unknown as QueryRunner);
    const sql = f.query.mock.calls.map(([statement]) => statement);
    expect(sql.filter(statement => statement.startsWith('DROP INDEX'))).toHaveLength(4);
    expect(sql.join(' ')).not.toMatch(/DELETE|TRUNCATE|DROP TABLE|UPDATE /);
  });
});
