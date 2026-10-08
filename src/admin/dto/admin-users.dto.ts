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

const REGISTRATION_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Inclusive calendar day in Kinshasa (UTC+1), as an absolute instant. */
export function parseRegistrationDay(value?: string | null): Date | undefined {
  if (value == null || value.trim() === '') {
    return undefined;
  }

  const match = REGISTRATION_DAY.exec(value.trim());
  if (!match) {
    throw new BadRequestException(
      "La date d'enregistrement doit être au format AAAA-MM-JJ.",
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new BadRequestException("Date d'enregistrement invalide.");
  }

  return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00+01:00`);
}

export function parseRegistrationRange(
  from?: string | null,
  to?: string | null,
): { from?: Date; to?: Date } {
  const start = parseRegistrationDay(from);
  const end = parseRegistrationDay(to);
  if (start && end && start.getTime() > end.getTime()) {
    throw new BadRequestException(
      'La date de début ne peut pas être après la date de fin.',
    );
  }

  return {
    from: start,
    to: end ? new Date(end.getTime() + 24 * 60 * 60 * 1000) : undefined,
  };
}
