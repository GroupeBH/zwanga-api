import { ConflictException } from '@nestjs/common';

export type DriverScheduleConflict = {
  kind: 'trip' | 'request';
  id: string;
  driverId: string;
  departure: string;
  arrival: string;
  departureDate: Date | string;
  status: string;
};

/** Private schedule details must not leak when a passenger accepts a driver's offer. */
export class DriverScheduleConflictException extends ConflictException {
  constructor(private readonly conflict?: DriverScheduleConflict, sharedTrip = false) {
    super({
      code: sharedTrip ? 'SHARED_TRIP_OFFER_REQUIRED' : 'DRIVER_SCHEDULE_CONFLICT',
      message: sharedTrip
        ? 'Vous avez un trajet en cours. Proposez son partage et attendez l’accord du passager.'
        : 'Vous avez déjà une course à cette heure. Choisissez une demande à un autre horaire.',
    });
  }

  forDriver(userId: unknown) {
    const value = this.conflict;
    if (!value || typeof userId !== 'string' || value.driverId !== userId) return undefined;
    const date = new Date(value.departureDate);
    if (!Number.isFinite(date.getTime())) return undefined;
    // Deliberate allowlist: never return an entity, passenger, contact or financial data.
    return { kind: value.kind, id: value.id, driverId: value.driverId,
      departure: value.departure, arrival: value.arrival,
      departureDate: date.toISOString(), status: value.status };
  }
}
