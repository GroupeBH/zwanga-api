import {
  arrivalDistance,
  arrivalObservationMatchesTrip,
  arrivalPoint,
  canAcceptArrivalPrompt,
  observeArrivalStop,
  type ArrivalStop,
} from './arrival-assistance.policy';
import type { TrackedLocationPoint } from '../common/services/location-history.service';

const epoch = Date.parse('2026-11-25T08:00:00Z');
const destination = { type: 'Point' as const, coordinates: [15.3, -4.3] };
const fix = (seconds: number, meters = 70): TrackedLocationPoint => ({
  latitude: -4.3 + meters / 111195,
  longitude: 15.3,
  recordedAt: new Date(epoch + seconds * 1000).toISOString(),
  accuracyMeters: 5,
  speedMetersPerSecond: 0,
  headingDegrees: null,
});

describe('observed near-destination stop', () => {
  const observe = (
    previous: ArrivalStop | null,
    seconds: number,
    patch: Partial<TrackedLocationPoint> = {},
  ) =>
    observeArrivalStop(
      previous,
      { ...fix(seconds), ...patch },
      destination,
      epoch + seconds * 1000,
      epoch - 1000,
    );
  it('requires more than five minutes of continuous recent observations, not an old fix', () => {
    let state: ArrivalStop | null = null;
    for (let t = 0; t <= 300; t += 30) state = observe(state, t);
    expect(state!.lastAt - state!.since).toBe(300000);
    state = observe(state, 330);
    expect(state!.lastAt - state!.since).toBe(330000);
    expect(state!.observations).toBe(12);
    expect(
      observeArrivalStop(
        state,
        fix(330),
        destination,
        epoch + 600000,
        epoch - 1000,
      ),
    ).toBeNull();
  });
  it('duplicates never add duration, GPS gaps and movement reset the stop', () => {
    const initial = observe(null, 0)!;
    expect(observe(initial, 0)).toEqual(initial);
    expect(observe(initial, 60)!.since).toBe(epoch + 60000);
    expect(observe(initial, 30, { latitude: -4.3 + 30 / 111195 })!.since).toBe(
      epoch + 30000,
    );
    expect(observe(initial, 30, { speedMetersPerSecond: 4 })).toBeNull();
    expect(observe(initial, 30, { latitude: -4.3 + 150 / 111195 })).toBeNull();
  });
  it.each([null, NaN, -1, 36])('rejects GPS accuracy %s', (accuracyMeters) => {
    expect(observe(null, 0, { accuracyMeters })).toBeNull();
  });
  it('rejects future samples, unknown pickup time and invalid coordinates', () => {
    expect(
      observeArrivalStop(null, fix(10), destination, epoch, epoch - 1),
    ).toBeNull();
    expect(
      observeArrivalStop(null, fix(0), destination, epoch, NaN),
    ).toBeNull();
    expect(
      arrivalDistance(destination, {
        type: 'Point',
        coordinates: [Infinity, 0],
      }),
    ).toBe(Infinity);
    expect(
      arrivalDistance(destination, { type: 'Point', coordinates: [15, 91] }),
    ).toBe(Infinity);
  });
});

describe('bounded passenger arrival consent', () => {
  const fixture = (meters = 199) => ({
    booking: {
      status: 'accepted',
      pickedUp: true,
      droppedOff: false,
      passengerDestinationPoint: destination,
      arrivalPrompt: {
        id: 'prompt',
        proposedAt: new Date(epoch - 1000).toISOString(),
        expiresAt: new Date(epoch + 600000).toISOString(),
      },
    } as any,
    trip: {
      status: 'ongoing',
      arrivalPoint: destination,
      currentLocation: arrivalPoint(fix(0, meters)),
      lastLocationUpdateAt: new Date(epoch),
    } as any,
  });
  it('allows 199m but not 201m, requires the server prompt and fresh GPS', () => {
    const f = fixture();
    expect(canAcceptArrivalPrompt(f.booking, f.trip, epoch)).toBe(true);
    expect(canAcceptArrivalPrompt(f.booking, fixture(201).trip, epoch)).toBe(
      false,
    );
    expect(canAcceptArrivalPrompt(f.booking, f.trip, epoch + 46000)).toBe(
      false,
    );
    expect(
      canAcceptArrivalPrompt(
        { ...f.booking, arrivalPrompt: null },
        f.trip,
        epoch,
      ),
    ).toBe(false);
    expect(canAcceptArrivalPrompt(f.booking, f.trip, epoch + 600001)).toBe(
      false,
    );
    expect(
      canAcceptArrivalPrompt({ ...f.booking, pickedUp: false }, f.trip, epoch),
    ).toBe(false);
    expect(
      canAcceptArrivalPrompt(
        f.booking,
        { ...f.trip, status: 'cancelled' },
        epoch,
      ),
    ).toBe(false);
  });
  it('requires accurate Redis GPS at least as recent as locked SQL GPS', () => {
    const f = fixture();
    expect(arrivalObservationMatchesTrip(fix(0, 199), f.trip, epoch)).toBe(
      true,
    );
    expect(arrivalObservationMatchesTrip(fix(-1, 199), f.trip, epoch)).toBe(
      false,
    );
    expect(
      arrivalObservationMatchesTrip(
        { ...fix(0, 199), accuracyMeters: null },
        f.trip,
        epoch,
      ),
    ).toBe(false);
    expect(arrivalObservationMatchesTrip(fix(0, 50), f.trip, epoch)).toBe(
      false,
    );
  });
});
