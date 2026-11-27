import { copySqlProjection } from './copy-sql-projection';

describe('copy SQL projections', () => {
  it('preserves SQL scalar/date types and isolates JSON/arrays/dates, including own special keys', () => {
    const source = { id: 'id', amount: '1200.50', timestamp: new Date(), nullable: null,
      number: 3, flag: false, missing: undefined, bigint: 10n, json: JSON.parse('{"__proto__":{"safe":true}}'),
      points: [{ coordinates: [1, 2] }] };
    const copy = copySqlProjection(source);
    expect(copy).toEqual(source);
    expect(copy.timestamp).toBeInstanceOf(Date);
    copy.timestamp.setTime(0); copy.points[0].coordinates[0] = 99; copy.json.__proto__.safe = false;
    expect(source.timestamp.getTime()).toBeGreaterThan(0);
    expect(source.points[0].coordinates).toEqual([1, 2]);
    expect(source.json.__proto__.safe).toBe(true);
    expect(Object.getPrototypeOf(copy.json)).toBe(Object.prototype);
  });
});
