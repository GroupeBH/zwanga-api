import { BadRequestException } from '@nestjs/common';
import { VehicleType } from '../../vehicles/entities/vehicle.entity';
import { UserStatus } from '../../users/entities/user.entity';

export function parseAdminUserStatus(
  value?: string | null,
): UserStatus | undefined {
  if (value == null || value === '' || value === 'all') return undefined;
  if (Object.values(UserStatus).includes(value as UserStatus))
    return value as UserStatus;
  throw new BadRequestException(
    'status doit être active, inactive, suspended ou pending_kyc.',
  );
}

export const ADMIN_USER_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'lastLoginAt',
  'name',
  'firstName',
  'lastName',
] as const;
export type AdminUserSort = {
  sortBy: (typeof ADMIN_USER_SORT_FIELDS)[number];
  sortOrder: 'ASC' | 'DESC';
};

export function parseAdminUserSort(
  sortBy?: string,
  sortOrder?: string,
): AdminUserSort {
  const field = sortBy == null || sortBy === '' ? 'createdAt' : sortBy;
  if (!(ADMIN_USER_SORT_FIELDS as readonly string[]).includes(field)) {
    throw new BadRequestException(
      `sortBy doit être ${ADMIN_USER_SORT_FIELDS.join(', ')}.`,
    );
  }
  const order =
    sortOrder == null || sortOrder === ''
      ? ['name', 'firstName', 'lastName'].includes(field)
        ? 'ASC'
        : 'DESC'
      : typeof sortOrder === 'string'
        ? sortOrder.toUpperCase()
        : undefined;
  if (order !== 'ASC' && order !== 'DESC') {
    throw new BadRequestException('sortOrder doit être ASC ou DESC.');
  }
  return { sortBy: field as AdminUserSort['sortBy'], sortOrder: order };
}

export function parseAdminVehicleType(
  value?: string | null,
): VehicleType | undefined {
  if (value == null || value === '') return undefined;
  if (Object.values(VehicleType).includes(value as VehicleType)) {
    return value as VehicleType;
  }
  throw new BadRequestException(
    'vehicleType doit être car, motorcycle_2_wheels ou motorcycle_3_wheels.',
  );
}

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

const USER_SEARCH_ACCENTS = 'àâäáãåçéèêëìíîïñòóôöõùúûüýÿ';
const USER_SEARCH_FOLDED = 'aaaaaaceeeeiiiinooooouuuuyy';

// Static whitelist only: no client-provided SQL column/expression is interpolated.
export const ADMIN_USER_SORT_COLUMNS: Record<
  AdminUserSort['sortBy'],
  string[]
> = {
  createdAt: ['user.createdAt'],
  updatedAt: ['user.updatedAt'],
  lastLoginAt: ['user.lastLoginAt'],
  name: ['lastName', 'firstName'],
  firstName: ['firstName', 'lastName'],
  lastName: ['lastName', 'firstName'],
};

export function adminUserSortExpressions(sort: AdminUserSort): string[] {
  return ADMIN_USER_SORT_COLUMNS[sort.sortBy].map((column) =>
    column === 'firstName' || column === 'lastName'
      ? `translate(lower(user.${column}), '${USER_SEARCH_ACCENTS}', '${USER_SEARCH_FOLDED}')`
      : column,
  );
}

/** Case- and accent-folded text used on both sides of the user search. */
export function normalizeUserSearch(value?: string | null): string | undefined {
  const term = (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .slice(0, 160);
  return term || undefined;
}

export function userSearchLikePattern(term: string): string {
  return `%${term.replace(/[!%_]/g, '!$&')}%`;
}

export const USER_SEARCH_SQL = `translate(lower(concat_ws(' ', user.firstName, user.lastName, user.lastName, user.firstName, user.email, user.phone)), '${USER_SEARCH_ACCENTS}', '${USER_SEARCH_FOLDED}') LIKE :userSearch ESCAPE '!'`;

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
