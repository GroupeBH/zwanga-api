import { ConflictException } from '@nestjs/common';
import { recordDeclaration, NO_RIDE_DISPUTE_SQL } from './ride-declaration.policy';
import { declarationStatus, hasRideDispute, RideEvidence } from './ride-declaration.model';

const evidence = (eventId: string, decision: 'confirm' | 'reject' = 'confirm'): RideEvidence => ({
  eventId, decision, occurredAt: '2026-09-14T12:00:00.000Z', receivedAt: '2026-09-14T12:01:00.000Z',
});
describe('manual ride declaration policy', () => {
  it('one person cannot confirm for the other', () => {
    const result = recordDeclaration({}, 'pickup', 'passenger', evidence('one'), false);
    expect(result.ready).toBe(false);
    expect(result.declarations.pickup?.driver).toBeUndefined();
    expect(declarationStatus(result.declarations.pickup, false)).toBe('awaiting_other');
  });
  it('two matching people make the stage ready, and only once', () => {
    const one = recordDeclaration({}, 'pickup', 'driver', evidence('one'), false);
    const two = recordDeclaration(one.declarations, 'pickup', 'passenger', evidence('two'), false);
    expect(two.ready).toBe(true);
    expect(recordDeclaration(two.declarations, 'pickup', 'passenger', evidence('two'), true).changed).toBe(false);
  });
  it('the same ID cannot be reused with a different decision or evidence', () => {
    const one = recordDeclaration({}, 'pickup', 'driver', evidence('one'), false);
    expect(() => recordDeclaration(one.declarations, 'pickup', 'driver', evidence('one', 'reject'), false)).toThrow(ConflictException);
    expect(() => recordDeclaration(one.declarations, 'pickup', 'driver', { ...evidence('one'), latitude: 1 }, false)).toThrow(ConflictException);
    expect(() => recordDeclaration(one.declarations, 'dropoff', 'driver', evidence('one'), false)).toThrow(ConflictException);
  });
  it('a semantic retry with a fresh ID does not repeat a transition', () => {
    const one = recordDeclaration({}, 'pickup', 'driver', evidence('one'), false);
    expect(recordDeclaration(one.declarations, 'pickup', 'driver', evidence('another'), false).changed).toBe(false);
  });
  it('rejection blocks dual confirmation and is immutable', () => {
    const one = recordDeclaration({}, 'pickup', 'driver', evidence('one'), false);
    const two = recordDeclaration(one.declarations, 'pickup', 'passenger', evidence('two', 'reject'), false);
    expect(two.ready).toBe(false); expect(hasRideDispute(two.declarations)).toBe(true);
    expect(() => recordDeclaration(two.declarations, 'pickup', 'passenger', evidence('three'), false)).toThrow(ConflictException);
  });
  it('a trusted automatic confirmation supersedes a late positive declaration without a new transition', () => {
    expect(recordDeclaration({}, 'pickup', 'passenger', evidence('one'), true).changed).toBe(false);
  });
  it('a late rejection is not falsely acknowledged as a positive confirmation', () => {
    expect(() => recordDeclaration({}, 'dropoff', 'passenger', evidence('one', 'reject'), true)).toThrow(ConflictException);
  });
  it('SQL guards cover each actor and both stages, not only the stale in-memory booking', () => {
    const sql = NO_RIDE_DISPUTE_SQL('b."rideDeclarations"');
    expect(sql.match(/decision/g)).toHaveLength(4);
    expect(sql).toContain('dropoff'); expect(sql).toContain('pickup');
  });
});
