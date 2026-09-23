import { ConflictException } from '@nestjs/common';
import { declarationStatus, type RideActor, type RideDeclarations, type RideEvidence, type RideStage } from './ride-declaration.model';

/** Bounded receipts, one immutable declaration per person and stage. */
export function recordDeclaration(
  current: RideDeclarations | null | undefined,
  stage: RideStage,
  actor: RideActor,
  evidence: RideEvidence,
  applied: boolean,
): { declarations: RideDeclarations; changed: boolean; ready: boolean } {
  const declarations = current ?? {};
  for (const [savedStage, votes] of Object.entries(declarations)) {
    for (const [savedActor, vote] of Object.entries(votes ?? {})) {
      if (vote?.eventId !== evidence.eventId) continue;
      if (savedStage !== stage || savedActor !== actor ||
          vote.decision !== evidence.decision || vote.occurredAt !== evidence.occurredAt ||
          vote.latitude !== evidence.latitude || vote.longitude !== evidence.longitude ||
          vote.accuracy !== evidence.accuracy) {
        throw new ConflictException({ code: 'RIDE_EVENT_CONFLICT', message: 'Cette confirmation a déjà été enregistrée avec des informations différentes. Actualisez le trajet.' });
      }
      return { declarations, changed: false, ready: false };
    }
  }
  if (applied) {
    if (evidence.decision === 'reject') {
      throw new ConflictException({ code: 'RIDE_ALREADY_CONFIRMED', message: 'Cette étape est déjà validée. Contactez l’assistance pour signaler votre désaccord.' });
    }
    return { declarations, changed: false, ready: false };
  }
  const previous = declarations[stage]?.[actor];
  if (previous) {
    if (previous.decision !== evidence.decision) {
      throw new ConflictException({ code: 'RIDE_DECISION_LOCKED', message: 'Une réponse différente est déjà enregistrée. Contactez l’assistance pour la corriger.' });
    }
    return { declarations, changed: false, ready: false };
  }
  const votes = { ...declarations[stage], [actor]: evidence };
  return {
    declarations: { ...declarations, [stage]: votes },
    changed: true,
    ready: declarationStatus(votes, false) === 'ready',
  };
}

// Used in conditional UPDATEs as well as in memory: an automatic sample loaded
// before a manual declaration must not overwrite that declaration afterwards.
export const NO_RIDE_DISPUTE_SQL = (column: string) =>
  `NOT (${column} @> '{"pickup":{"driver":{"decision":"reject"}}}'::jsonb OR ${column} @> '{"pickup":{"passenger":{"decision":"reject"}}}'::jsonb OR ${column} @> '{"dropoff":{"driver":{"decision":"reject"}}}'::jsonb OR ${column} @> '{"dropoff":{"passenger":{"decision":"reject"}}}'::jsonb)`;
