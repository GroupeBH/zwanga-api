import { IsNull, MoreThan, Not, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';

/** Keyset batches keep cron memory bounded without changing legacy API responses. */
export async function* activePushUsers(
  users: Repository<User>,
): AsyncGenerator<User> {
  let cursor: string | undefined;
  for (;;) {
    const batch = await users.find({
      where: {
        isActive: true,
        fcmToken: Not(IsNull()),
        ...(cursor ? { id: MoreThan(cursor) } : {}),
      },
      select: ['id', 'firstName', 'role', 'fcmToken'],
      order: { id: 'ASC' },
      take: 100,
    });
    for (const user of batch) if (user.fcmToken?.trim()) yield user;
    if (batch.length < 100) return;
    cursor = batch[batch.length - 1].id;
  }
}
