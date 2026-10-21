import { User, UserStatus } from '../users/entities/user.entity';

/** Admin-only presentation. Never infer deletion from isActive=false alone. */
export function adminUserIdentity(user: Partial<User>) {
  // Legacy account deletion erases these fields; there is no deletedAt column.
  const isDeleted =
    user.status === UserStatus.INACTIVE &&
    user.isActive === false &&
    user.firstName === 'Compte' &&
    user.lastName === 'supprimé' &&
    !user.email &&
    !user.phone &&
    !user.googleId &&
    !user.appleId;
  return {
    isDeleted,
    displayName:
      `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() ||
      'Nom non renseigné',
  };
}
