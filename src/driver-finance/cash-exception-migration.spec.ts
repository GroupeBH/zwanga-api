import { DriverCashExceptions1780000145000 } from '../database/migrations/1780000145000-DriverCashExceptions';

describe('cash exception migration release safety', () => {
  const anchor =
    '  PERFORM zwanga_cash_sync(NEW.id,t."driverId",t.id,NEW."paymentAmount",NEW."cashCommissionTokenValue",next_state,require_funds,';
  function fixture(definition = `-- Arrival-only cash fallback\n${anchor}`) {
    const query = jest.fn((sql: string) =>
      Promise.resolve(
        sql.startsWith('SELECT pg_get_functiondef') ? [{ definition }] : [],
      ),
    );
    const runner = { isTransactionActive: true, query };
    return { query, runner };
  }
  it('requires an atomic migration and refuses missing/ambiguous/previously modified guards', async () => {
    const migration = new DriverCashExceptions1780000145000();
    const f = fixture();
    f.runner.isTransactionActive = false;
    await expect(migration.up(f.runner as never)).rejects.toThrow(
      'transaction',
    );
    expect(f.query).not.toHaveBeenCalled();
    for (const text of [
      '',
      anchor,
      `-- Arrival-only cash fallback\n${anchor}${anchor}`,
      `-- Arrival-only cash fallback\n${anchor} zwanga_cash_exception_authorize`,
    ]) {
      const invalid = fixture(text);
      await expect(migration.up(invalid.runner as never)).rejects.toThrow(
        'Unexpected cash guard',
      );
      expect(
        invalid.query.mock.calls.some(([sql]) => sql.includes('CREATE TABLE')),
      ).toBe(false);
    }
  });
  it('starts with a disabled release gate and refuses destructive rollback', async () => {
    const f = fixture();
    const migration = new DriverCashExceptions1780000145000();
    await migration.up(f.runner as never);
    expect(
      f.query.mock.calls.some(([sql]) =>
        sql.includes(
          'driver_cash_exception_rollout(id,enabled) VALUES(true,false)',
        ),
      ),
    ).toBe(true);
    expect(f.query.mock.calls.at(-1)?.[0]).toContain(
      'NEW."mixedPaymentAt" IS NULL',
    );
    await expect(migration.down()).rejects.toThrow('forward migration');
  });
});
