import type { Repository } from 'typeorm';
import type { User } from '../users/entities/user.entity';

type PushRecipient = Pick<User, 'id' | 'fcmToken' | 'role' | 'isActive' | 'status'> & {
  hasExclusivePushToken: boolean;
};

/** One fresh statement per attempt, not a cache of tokens or authorization.
 * Retain the ownership check even on installations without the unique index.
 * EXISTS stops at the first competing owner; disabled accounts count too.
 */
export async function readPushRecipient(
  repository: Pick<Repository<User>, 'query'>,
  userId: string,
): Promise<PushRecipient | null> {
  const [owner] = await repository.query<PushRecipient[]>(`SELECT u.id, u."fcmToken", u.role, u."isActive", u.status,
    NOT EXISTS (SELECT 1 FROM users other WHERE other."fcmToken"=u."fcmToken" AND other.id<>u.id)
      AS "hasExclusivePushToken"
    FROM users u WHERE u.id=$1`, [userId]);
  if (!owner) return null;
  // Never turn a padded legacy value into another account's canonical token.
  owner.hasExclusivePushToken = owner.hasExclusivePushToken && Boolean(owner.fcmToken) &&
    owner.fcmToken === owner.fcmToken?.trim();
  return owner;
}
