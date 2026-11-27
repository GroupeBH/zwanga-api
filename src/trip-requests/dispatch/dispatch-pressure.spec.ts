import { dispatchPoolBusy } from './dispatch-pressure';

it('observes only the live primary pool and does not mistake a historical peak for current pressure', () => {
  const pool = { waitingCount: 0, peakWaiting: 50 };
  const db = { driver: { master: pool } };
  expect(dispatchPoolBusy(db as never)).toBe(false);
  pool.waitingCount = 1; expect(dispatchPoolBusy(db as never)).toBe(false);
  pool.waitingCount = 2; expect(dispatchPoolBusy(db as never)).toBe(true);
  pool.waitingCount = 0; expect(dispatchPoolBusy(db as never)).toBe(false);
  expect(dispatchPoolBusy({} as never)).toBe(false);
});
