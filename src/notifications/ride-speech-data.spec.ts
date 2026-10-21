import { rideSpeechData } from './ride-speech-data';

describe('structured foreground speech metadata', () => {
  it('includes an explicit per-seat fare or proposed budget for native notification cards', () => {
    expect(rideSpeechData({ pricePerSeat: '2500.50', priceKind: 'budget' })).toEqual({
      rideSpeechVersion: '1', ridePricePerSeat: '2500.50', ridePriceKind: 'budget',
    });
    expect(rideSpeechData({ pricePerSeat: 0, priceKind: 'fare' })).toEqual({
      rideSpeechVersion: '1', ridePricePerSeat: '0', ridePriceKind: 'fare',
    });
    for (const pricePerSeat of [undefined, null, '', '  ', -1, NaN, Infinity, '2,500', '1e3', '12.345']) {
      expect(rideSpeechData({ pricePerSeat, priceKind: 'fare' })).toEqual({ rideSpeechVersion: '1' });
    }
    expect(rideSpeechData({ pricePerSeat: 1000 })).toEqual({ rideSpeechVersion: '1' });
  });
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
