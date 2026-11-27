import { BadRequestException } from '@nestjs/common';

/** Raised only AFTER ownership validation. A refused GPS write is never an accepted one. */
export class TrackingStateChangedException extends BadRequestException {
  constructor(readonly tripId: string, readonly bookingId?: string, message?: string) {
    // Existing mobile HTTP fallbacks recognize these 400 messages. Keep that
    // contract while adding a machine-readable code for newer socket clients.
    super({ code: 'TRACKING_STATE_CHANGED', message: message ?? (bookingId
      ? 'Seules les réservations acceptées ou récupérables peuvent partager leur position'
      : 'Le trajet n’est plus en cours, le suivi en temps réel est arrêté') });
  }
}
