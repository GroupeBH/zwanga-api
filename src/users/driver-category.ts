import { BadRequestException } from '@nestjs/common';

/** Descriptive activity only: never an authorization, KYC or dispatch role. */
export enum DriverCategory {
  PRIVATE = 'private',
  TRANSPORT = 'transport',
}

export function resolveDriverCategory(value: unknown, hasDriverIntent: boolean): DriverCategory | null {
  // Legacy registrations remain compatible and are not classified implicitly.
  if (value === undefined || value === null) return null;
  if (!Object.values(DriverCategory).includes(value as DriverCategory)) {
    throw new BadRequestException('Choisissez un type de conducteur valide.');
  }
  if (!hasDriverIntent) throw new BadRequestException('Ce choix est réservé au profil conducteur.');
  return value as DriverCategory;
}
