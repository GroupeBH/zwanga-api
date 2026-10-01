import {
  KycDocument,
  KycProvider,
  KycStatus,
} from './entities/kyc-document.entity';
import { User, UserRole, UserStatus } from './entities/user.entity';
import { isAdminRole } from './user-role.policy';

export const LATEST_IDENTITY_ORDER = { createdAt: 'DESC', id: 'DESC' } as const;
export type ProfileIdentityStatus =
  'not_started' | 'pending' | 'approved' | 'rejected';
export type DriverProfileAction =
  | 'start'
  | 'verify_identity'
  | 'add_vehicle'
  | 'wait'
  | 'activate'
  | 'none'
  | 'contact_support';
export type DriverProfileStatus =
  | 'not_requested'
  | 'identity_required'
  | 'identity_pending'
  | 'vehicle_required'
  | 'ready_to_activate'
  | 'active'
  | 'restricted';

export interface ProfileState {
  version: 1;
  userId: string;
  identity: { status: ProfileIdentityStatus; rejectionReason: string | null };
  driver: {
    status: DriverProfileStatus;
    nextAction: DriverProfileAction;
    canPublish: boolean;
    activeVehicleCount: number;
    requested: boolean;
  };
}

export function latestProfileIdentity(
  documents: KycDocument[],
): KycDocument | null {
  return (
    [...documents].sort((a, b) => {
      const delta =
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return delta || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    })[0] ?? null
  );
}

// Presentation is computed from server data; GET never promotes or demotes a user.
export function buildProfileState(user: User): ProfileState {
  const document = latestProfileIdentity(user.kycDocuments ?? []);
  const notStarted =
    document?.provider === KycProvider.DIDIT &&
    document.status === KycStatus.PENDING &&
    String(document.diditSessionStatus ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, ' ') === 'not started';
  const identityStatus: ProfileIdentityStatus =
    !document || notStarted ? 'not_started' : document.status;
  const activeVehicleCount = (user.vehicles ?? []).filter(
    (vehicle) => vehicle.ownerId === user.id && vehicle.isActive === true,
  ).length;
  const isDriver = user.role === UserRole.DRIVER;
  const requested = isDriver || Boolean(user.driverOnboardingRequestedAt);
  const restricted =
    isAdminRole(user.role) ||
    !user.isActive ||
    user.status === UserStatus.SUSPENDED ||
    user.status === UserStatus.INACTIVE;
  const canPublish =
    !restricted &&
    isDriver &&
    identityStatus === 'approved' &&
    activeVehicleCount > 0;
  let status: DriverProfileStatus;
  let nextAction: DriverProfileAction;
  if (restricted) {
    status = 'restricted';
    nextAction = 'contact_support';
  } else if (canPublish) {
    status = 'active';
    nextAction = 'none';
  } else if (!requested) {
    status = 'not_requested';
    nextAction = 'start';
  } else if (
    identityStatus === 'not_started' ||
    identityStatus === 'rejected'
  ) {
    status = 'identity_required';
    nextAction = 'verify_identity';
  } else if (activeVehicleCount === 0) {
    status = 'vehicle_required';
    nextAction = 'add_vehicle';
  } else if (identityStatus === 'pending') {
    status = 'identity_pending';
    nextAction = 'wait';
  } else {
    status = 'ready_to_activate';
    nextAction = 'activate';
  }
  return {
    version: 1,
    userId: user.id,
    identity: {
      status: identityStatus,
      rejectionReason:
        identityStatus === 'rejected'
          ? (document?.rejectionReason ?? null)
          : null,
    },
    driver: { status, nextAction, canPublish, activeVehicleCount, requested },
  };
}
