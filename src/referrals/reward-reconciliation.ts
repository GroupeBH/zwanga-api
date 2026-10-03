import type { DataSource, EntityManager } from 'typeorm';
import { ReferralReward, ReferralRewardStatus } from './entities/referral-reward.entity';

/** Coalesce callers in one process; serialize batches for the same account across instances. */
export function reconcileReferralRewards(
  source: DataSource, pending: Map<string, Promise<void>>, userId: string,
  release: (id: string, manager: EntityManager) => Promise<void>,
): Promise<void> {
  const existing = pending.get(userId);
  if (existing) return existing;
  const work = (async () => {
    // Same 500-reward upper bound as the old read path, in short batches of 25.
    for (let batch = 0; batch < 20; batch++) {
      const count = await source.transaction(async manager => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`referral-release:${userId}`]);
        const rewards = await manager.getRepository(ReferralReward).createQueryBuilder('reward')
          .where('reward.referrerUserId = :userId', { userId })
          .andWhere('reward.status = :status', { status: ReferralRewardStatus.PENDING })
          .andWhere('reward.holdUntil <= :now', { now: new Date() })
          .orderBy('reward.id', 'ASC').take(25)
          // Lock the batch before touching its balance. A cron/reversal already holding
          // a reward finishes independently; never wait for it while holding its account.
          .setLock('pessimistic_write').setOnLocked('skip_locked').getMany();
        for (const reward of rewards) await release(reward.id, manager);
        return rewards.length;
      });
      if (count < 25) break;
    }
  })();
  pending.set(userId, work);
  const clear = () => { if (pending.get(userId) === work) pending.delete(userId); };
  void work.then(clear, clear);
  return work;
}
