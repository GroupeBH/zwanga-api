import { reconcileReferralRewards } from './reward-reconciliation';

describe('bounded referral reconciliation', () => {
  function fixture(rows: number) {
    const pending = new Map<string, Promise<void>>();
    const query: any = {};
    for (const key of ['where', 'andWhere', 'orderBy', 'take', 'setLock', 'setOnLocked']) query[key] = jest.fn().mockReturnValue(query);
    query.getMany = jest.fn(async () => Array.from({ length: Math.min(25, rows) }, (_, i) => ({ id: String(i) })));
    const manager: any = { query: jest.fn().mockResolvedValue([]), getRepository: () => ({ createQueryBuilder: () => query }) };
    const source: any = { transaction: jest.fn(async fn => fn(manager)) };
    const release = jest.fn(async () => { rows--; });
    return { pending, query, source, manager, release };
  }
  it('coalesces three reads and preserves all 500 releases with at most twenty transactions', async () => {
    const f = fixture(500);
    const start = () => reconcileReferralRewards(f.source, f.pending, 'owner', f.release);
    await Promise.all([start(), start(), start()]);
    expect(f.release).toHaveBeenCalledTimes(500);
    expect(f.source.transaction).toHaveBeenCalledTimes(20);
    expect(f.query.take).toHaveBeenCalledWith(25);
    expect(f.query.where).toHaveBeenCalledWith('reward.referrerUserId = :userId', { userId: 'owner' });
    expect(f.manager.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['referral-release:owner']);
    expect(f.pending.size).toBe(0);
  });
  it('does not acknowledge a failed transaction and allows retry', async () => {
    const f = fixture(1); f.release.mockRejectedValueOnce(new Error('rollback'));
    await expect(reconcileReferralRewards(f.source, f.pending, 'owner', f.release)).rejects.toThrow('rollback');
    expect(f.pending.size).toBe(0);
    await reconcileReferralRewards(f.source, f.pending, 'owner', f.release);
    expect(f.source.transaction).toHaveBeenCalledTimes(2);
  });
  it('does not mix accounts and retains the cron-safe locked-row policy', async () => {
    const f = fixture(0);
    await Promise.all(['a', 'b'].map(id => reconcileReferralRewards(f.source, f.pending, id, f.release)));
    expect(f.source.transaction).toHaveBeenCalledTimes(2);
    expect(f.query.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(f.query.setOnLocked).toHaveBeenCalledWith('skip_locked');
    expect(f.release).not.toHaveBeenCalled();
  });
});
