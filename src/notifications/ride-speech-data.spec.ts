import { rideSpeechData } from './ride-speech-data';

describe('structured foreground speech metadata', () => {
  it('carries only bounded scalar route details, no personal or arbitrary input fields', () => {
    const data = rideSpeechData({ departure: '  <b>Place centrale</b>\n', arrival: 'Gare', seats: 2,
      departureAt: new Date('2026-10-21T09:00:00Z'), phone: 'not-for-push', passengerName: 'not-for-push' } as any);
    expect(data).toEqual({ rideSpeechVersion: '1', rideDeparture: 'Place centrale', rideArrival: 'Gare', rideSeats: '2',
      rideDepartureAt: '2026-10-21T09:00:00.000Z' });
    expect(Object.values(data).every(value => typeof value === 'string')).toBe(true);
  });
  it('accepts missing legacy fields and rejects invalid dates and seat counts', () => {
    expect(rideSpeechData({ departureAt: new Date('invalid'), seats: -2 })).toEqual({ rideSpeechVersion: '1' });
    expect(rideSpeechData({ seats: 1.5 })).toEqual({ rideSpeechVersion: '1' });
    expect(rideSpeechData({ departure: 'a'.repeat(2000) }).rideDeparture).toHaveLength(80);
  });
});
