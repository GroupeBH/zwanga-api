import { User, UserStatus } from '../users/entities/user.entity';

/** Admin-only presentation. Never infer deletion from isActive=false alone. */
export function adminUserIdentity(user: Partial<User>) {
  // Keep the legacy signature for older records and partial admin projections.
  const isDeleted =
    Boolean(user.deletedAt) ||
    (user.status === UserStatus.INACTIVE &&
      user.isActive === false &&
      user.firstName === 'Compte' &&
      user.lastName === 'supprimé' &&
      !user.email &&
      !user.phone &&
      !user.googleId &&
      !user.appleId);
  return {
    isDeleted,
    displayName:
      `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() ||
      'Nom non renseigné',
  };
}
