import { BadRequestException } from '@nestjs/common';

export const ADMIN_USER_SEGMENTS = [
  'driver',
  'passenger',
  'verified_passenger',
] as const;

export type AdminUserSegment = (typeof ADMIN_USER_SEGMENTS)[number];

export function parseAdminUserSegment(
  segment?: string | null,
): AdminUserSegment | undefined {
  if (segment == null || segment === '') {
    return undefined;
  }

  if ((ADMIN_USER_SEGMENTS as readonly string[]).includes(segment)) {
    return segment as AdminUserSegment;
  }

  throw new BadRequestException(
    'Le filtre doit être driver, passenger ou verified_passenger',
  );
}
