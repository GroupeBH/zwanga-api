import { ConflictException } from '@nestjs/common';
import { recordDeclaration, NO_RIDE_DISPUTE_SQL } from './ride-declaration.policy';
import { declarationStatus, pickupDeclarationStatus, hasRideDispute, RideEvidence } from './ride-declaration.model';

const evidence = (eventId: string, decision: 'confirm' | 'reject' = 'confirm'): RideEvidence => ({
  eventId, decision, occurredAt: '2026-09-14T12:00:00.000Z', receivedAt: '2026-09-14T12:01:00.000Z',
});
describe('manual ride declaration policy', () => {
  for (const stage of ['pickup', 'dropoff'] as const) {
    for (const first of ['passenger', 'driver'] as const) {
      const second = first === 'driver' ? 'passenger' : 'driver';
      it(`${stage} needs both declarations, with ${first} first`, () => {
        const one = recordDeclaration({}, stage, first, evidence('one'), false);
        expect(one.ready).toBe(false);
        expect(one.declarations[stage]?.[second]).toBeUndefined();
        expect(declarationStatus(one.declarations[stage], false)).toBe('awaiting_other');
        expect(recordDeclaration(one.declarations, stage, first, evidence('one'), false).ready).toBe(false);
        const two = recordDeclaration(one.declarations, stage, second, evidence('two'), false);
        expect(two.ready).toBe(true);
        expect(pickupDeclarationStatus(two.declarations[stage], false)).toBe('ready');
        const replay = recordDeclaration(two.declarations, stage, second, evidence('two'), false);
        expect(replay).toEqual({ declarations: two.declarations, changed: false, ready: true });
        expect(recordDeclaration(two.declarations, stage, second, evidence('two'), true).ready).toBe(false);
      });
    }
  }
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
  it('a lone provisional passenger receipt cannot be promoted or rewritten on replay', () => {
    const old = { pickup: { passenger: evidence('existing') } };
    const replay = recordDeclaration(old, 'pickup', 'passenger', evidence('existing'), false);
    expect(replay).toEqual({ declarations: old, changed: false, ready: false });
    expect(recordDeclaration(old, 'pickup', 'passenger', evidence('fresh-id'), false).declarations).toBe(old);
    expect(recordDeclaration(old, 'pickup', 'passenger', evidence('existing'), true).ready).toBe(false);
  });
  it('an historical dispute is not silently erased by a passenger pickup', () => {
    const old = { pickup: { driver: evidence('old-rejection', 'reject') } };
    const result = recordDeclaration(old, 'pickup', 'passenger', evidence('new'), false);
    expect(result.ready).toBe(false);
    expect(pickupDeclarationStatus(result.declarations.pickup, false)).toBe('disputed');
  });
});
