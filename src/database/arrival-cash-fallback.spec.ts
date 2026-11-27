import { QueryRunner } from 'typeorm';
import { ArrivalCashFallback1780000143000 } from './migrations/1780000143000-ArrivalCashFallback';

describe('arrival cash fallback migration safeguards', () => {
  const before = `IF validate_mode AND COALESCE(NEW."paymentAmount",0) > 0 AND NOT (NEW."paymentMode" = ANY(t."acceptedPaymentModes")) THEN RAISE EXCEPTION 'TRIP_PAYMENT_MODE_UNAVAILABLE'; END IF;`;
  it('refuses nontransactional execution', async () => {
    const query = jest.fn();
    await expect(
      new ArrivalCashFallback1780000143000().up({
        isTransactionActive: false,
        query,
      } as unknown as QueryRunner),
    ).rejects.toThrow('transaction');
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    null,
    'unknown guard',
    before + before,
    'Arrival-only cash fallback ' + before,
  ])(
    'refuses missing, changed or already changed guard (%s)',
    async (definition) => {
      const query = jest.fn((sql: string) =>
        Promise.resolve(sql.startsWith('SELECT') ? [{ definition }] : []),
      );
      await expect(
        new ArrivalCashFallback1780000143000().up({
          isTransactionActive: true,
          query,
        } as unknown as QueryRunner),
      ).rejects.toThrow('Unexpected');
      expect(query).toHaveBeenCalledTimes(3);
    },
  );
  it('preserves the remainder of the financial guard and has no destructive rollback', async () => {
    const definition = `CREATE OR REPLACE FUNCTION guard() ${before} commission_checks_keep();`;
    const query = jest.fn((sql: string) =>
      Promise.resolve(sql.startsWith('SELECT') ? [{ definition }] : []),
    );
    const migration = new ArrivalCashFallback1780000143000();
    await migration.up({
      isTransactionActive: true,
      query,
    } as unknown as QueryRunner);
    const sql = query.mock.calls[3][0];
    expect(sql).toContain(before);
    expect(sql.endsWith('commission_checks_keep();')).toBe(true);
    expect(sql).toContain(`OLD.status = 'completed'`);
    await expect(migration.down()).rejects.toThrow('forward migration');
  });
});
