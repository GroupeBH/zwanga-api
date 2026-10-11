import { User, UserRole, UserStatus } from '../users/entities/user.entity';

// Only invitations to serve another passenger. Updates to one's own order stay visible.
export const DRIVER_REQUEST_NOTIFICATION_TYPES = [
  'trip_request', 'new_trip_request', 'trip_request_nearby', 'driver_dispatch_offer',
] as const;

export function isDriverRequestNotification(data?: Record<string, unknown> | null): boolean {
  return DRIVER_REQUEST_NOTIFICATION_TYPES.some(type => type === data?.type);
}

export function canReceiveDriverRequests(user: Pick<User, 'role' | 'isActive' | 'status'> | null): boolean {
  return user?.role === UserRole.DRIVER && user.isActive === true &&
    user.status !== UserStatus.SUSPENDED && user.status !== UserStatus.INACTIVE;
}
