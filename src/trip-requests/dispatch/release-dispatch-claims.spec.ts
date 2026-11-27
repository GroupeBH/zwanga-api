import { releaseDispatchClaims } from './release-dispatch-claims';

describe('batch fallback-claim release', () => {
  it('deduplicates a batch and checks ownership without waiting for business locks', async () => {
    const db = { query: jest.fn().mockResolvedValue([]) };
    await releaseDispatchClaims(db, ['a', 'b', 'a'], 'lease');
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, args] = db.query.mock.calls[0];
    expect(args).toEqual([['a', 'b'], 'lease']);
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql.match(/"dispatchLeaseId"=\$2/g)).toHaveLength(2);
  });
  it('does not acquire a connection for an empty scan', async () => {
    const db = { query: jest.fn() };
    await releaseDispatchClaims(db, [], 'lease');
    expect(db.query).not.toHaveBeenCalled();
  });
});
