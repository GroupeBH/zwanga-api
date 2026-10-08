import { QueryRunner } from 'typeorm';
import { FixBookingRequestUuid1780000058000, bookingRequestUuidReplacements } from './migrations/1780000058000-FixBookingRequestUuid';

describe('booking request UUID repair', () => {
  const old = `CREATE OR REPLACE FUNCTION guard() RETURNS trigger AS $$ BEGIN
    SELECT * FROM trip_requests WHERE id = t."tripRequestId";
    UPDATE cash_commissions SET state='reserved' WHERE "requestId" = t."tripRequestId" AND state='reserved';
    RETURN NEW; END $$ LANGUAGE plpgsql;`;
  const fixed = bookingRequestUuidReplacements.reduce((sql, [before, after]) => sql.replace(before, after), old);
  const fixture = (definition = old, active = true) => {
    const query = jest.fn(async (sql: string) => sql.startsWith('SELECT pg_get') ? [{ definition }] : []);
    return { query, runner: { query, isTransactionActive: active } as unknown as QueryRunner };
  };
  it('changes only the two comparisons', async () => {
    const { query, runner } = fixture();
    await new FixBookingRequestUuid1780000058000().up(runner);
    expect(query.mock.calls.at(-1)![0]).toBe(fixed);
    expect(query.mock.calls).toHaveLength(4);
  });
  it('is idempotent and completes a partially corrected body', async () => {
    const ready = fixture(fixed);
    await new FixBookingRequestUuid1780000058000().up(ready.runner);
    expect(ready.query.mock.calls).toHaveLength(3);
    const partial = fixture(old.replace(...bookingRequestUuidReplacements[0]));
    await new FixBookingRequestUuid1780000058000().up(partial.runner);
    expect(partial.query.mock.calls.at(-1)![0]).toBe(fixed);
  });
  it('refuses an unexpected function before rewriting anything', async () => {
    const { runner, query } = fixture(old.replace('AND state', 'OR state'));
    await expect(new FixBookingRequestUuid1780000058000().up(runner)).rejects.toThrow('Unexpected');
    expect(query.mock.calls).toHaveLength(3);
  });
  it('requires a transaction and refuses to restore broken SQL', async () => {
    const { query, runner } = fixture(old, false);
    await expect(new FixBookingRequestUuid1780000058000().up(runner)).rejects.toThrow('transaction');
    expect(query).not.toHaveBeenCalled();
    await expect(new FixBookingRequestUuid1780000058000().down()).rejects.toThrow('forward fix');
  });
});
