import { QueryRunner } from 'typeorm';
import { FixPublicationRequestUuid1780000057000 } from './migrations/1780000057000-FixPublicationRequestUuid';

describe('publication request UUID migration', () => {
  const old = 'CREATE OR REPLACE FUNCTION zwanga_publication_cash_guard() RETURNS trigger AS $$ BEGIN SELECT * INTO r FROM trip_requests WHERE id = NEW."tripRequestId"; RETURN NEW; END $$ LANGUAGE plpgsql;';
  const fixed = old.replace('NEW."tripRequestId";', 'NEW."tripRequestId"::uuid;');
  const fixture = (definition = old, active = true) => {
    const query = jest.fn(async (sql: string) => sql.startsWith('SELECT pg_get') ? [{ definition }] : []);
    return { query, runner: { query, isTransactionActive: active } as unknown as QueryRunner };
  };
  it('changes only the legacy comparison, not policy, function identity or data', async () => {
    const { query, runner } = fixture();
    await new FixPublicationRequestUuid1780000057000().up(runner);
    expect(query.mock.calls.at(-1)![0]).toBe(fixed);
    expect(query.mock.calls).toHaveLength(4);
  });
  it('is safe to repeat and refuses an unexpected deployed function', async () => {
    const ready = fixture(fixed);
    await new FixPublicationRequestUuid1780000057000().up(ready.runner);
    expect(ready.query.mock.calls).toHaveLength(3);
    await expect(new FixPublicationRequestUuid1780000057000().up(fixture('unexpected').runner)).rejects.toThrow('Unexpected');
  });
  it('requires transactional application and refuses destructive rollback', async () => {
    const { query, runner } = fixture(old, false);
    await expect(new FixPublicationRequestUuid1780000057000().up(runner)).rejects.toThrow('transaction');
    expect(query).not.toHaveBeenCalled();
    await expect(new FixPublicationRequestUuid1780000057000().down()).rejects.toThrow('forward fix');
  });
});
