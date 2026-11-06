import { AdminAnalyticsIndexes1780000114000 } from './migrations/1780000114000-AdminAnalyticsIndexes';

describe('online admin indexes', () => {
  const migration = new AdminAnalyticsIndexes1780000114000();
  function runner(invalid = false) {
    let checked = false;
    return {
      isTransactionActive: false,
      query: jest.fn(
        async (sql: string, _params?: unknown[]): Promise<any[]> => {
          if (sql.startsWith('SELECT current_setting'))
            return [{ lock_timeout: '0', statement_timeout: '1min' }];
          if (sql.startsWith('SELECT indisvalid')) {
            if (invalid && !checked) {
              checked = true;
              return [{ indisvalid: false }];
            }
            return [{ indisvalid: true }];
          }
          return [];
        },
      ),
    };
  }
  it('opts out of transactions and builds all ten indexes online', async () => {
    const q = runner();
    expect(migration.transaction).toBe(false);
    await migration.up(q as any);
    expect(
      q.query.mock.calls.filter(([sql]) =>
        sql.startsWith('CREATE INDEX CONCURRENTLY'),
      ),
    ).toHaveLength(10);
    expect(q.query).toHaveBeenLastCalledWith(
      expect.stringContaining("set_config('lock_timeout',$1,false)"),
      ['0', '1min'],
    );
  });
  it('repairs an invalid index before retrying a failed build', async () => {
    const q = runner(true);
    await migration.up(q as any);
    expect(q.query).toHaveBeenCalledWith(
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_admin_trips_created"',
    );
  });
  it('refuses to run inside a transaction before executing DDL', async () => {
    const q = runner();
    q.isTransactionActive = true;
    await expect(migration.up(q as any)).rejects.toThrow(
      'transaction mode each',
    );
    expect(q.query).not.toHaveBeenCalled();
  });
  it('restores session budgets even after a failed build', async () => {
    const q = runner();
    q.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT current_setting'))
        return [{ lock_timeout: '0', statement_timeout: '1min' }];
      if (sql.startsWith('CREATE INDEX')) throw new Error('timeout');
      return [];
    });
    await expect(migration.up(q as any)).rejects.toThrow('timeout');
    expect(q.query).toHaveBeenLastCalledWith(expect.any(String), ['0', '1min']);
  });
  it('removes only its own indexes concurrently on rollback', async () => {
    const q = runner();
    await migration.down(q as any);
    expect(
      q.query.mock.calls.filter(([sql]) =>
        sql.startsWith('DROP INDEX CONCURRENTLY'),
      ),
    ).toHaveLength(10);
  });
  it('supports the TypeORM transactional revert executor with short locks', async () => {
    const q = runner();
    q.isTransactionActive = true;
    await migration.down(q as any);
    expect(q.query).toHaveBeenCalledWith("SET LOCAL lock_timeout='3s'");
    expect(
      q.query.mock.calls.filter(([sql]) =>
        sql.startsWith('DROP INDEX IF EXISTS'),
      ),
    ).toHaveLength(10);
    expect(
      q.query.mock.calls.some(([sql]) => sql.includes('CONCURRENTLY')),
    ).toBe(false);
  });
});
