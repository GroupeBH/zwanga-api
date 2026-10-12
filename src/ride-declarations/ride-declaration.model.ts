export type RideStage = 'pickup' | 'dropoff';
export type RideDecision = 'confirm' | 'reject';
export type RideActor = 'driver' | 'passenger';
export interface RideEvidence {
  eventId: string;
  decision: RideDecision;
  occurredAt: string;
  receivedAt: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
}
export interface StageDeclarations {
  driver?: RideEvidence;
  passenger?: RideEvidence;
}
export type RideDeclarations = Partial<Record<RideStage, StageDeclarations>>;

export function declarationStatus(stage: StageDeclarations | undefined, applied: boolean) {
  if (applied) return 'confirmed' as const;
  if (stage?.driver?.decision === 'reject' || stage?.passenger?.decision === 'reject') return 'disputed' as const;
  if (stage?.driver?.decision === 'confirm' && stage?.passenger?.decision === 'confirm') return 'ready' as const;
  if (stage?.driver || stage?.passenger) return 'awaiting_other' as const;
  return 'none' as const;
}

/** Boarding still needs both parties; automatic confirmations stay authoritative. */
export function pickupDeclarationStatus(stage: StageDeclarations | undefined, applied: boolean) {
  return declarationStatus(stage, applied);
}

/** The reservation holder can finish their own ride without waiting for the driver. */
export function dropoffDeclarationStatus(stage: StageDeclarations | undefined, applied: boolean) {
  const status = declarationStatus(stage, applied);
  if (status === 'awaiting_other' && stage?.passenger?.decision === 'confirm') return 'ready' as const;
  return status;
}

export function hasRideDispute(data?: RideDeclarations | null) {
  return (['pickup', 'dropoff'] as const).some(stage => declarationStatus(data?.[stage], false) === 'disputed');
}
