import type { EntityManager } from 'typeorm';
import { assertDriverRequestSchedule } from './driver-schedule-policy';
import { DriverScheduleConflictException } from '../../common/driver-schedule-conflict';

describe('driver schedule conflict explanation', () => {
  it('does not add a details query to successful acceptances', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ busy: false }]);
    await assertDriverRequestSchedule({ query } as unknown as EntityManager, 'driver', 'request');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]).toEqual(['SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', ['driver']]);
  });

  it('uses bound parameters for the extra read and keeps a failure a conflict if details are absent', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ busy: true }]).mockResolvedValueOnce([]);
    const driver = 'not interpolated', request = 'also not interpolated';
    await expect(assertDriverRequestSchedule({ query } as unknown as EntityManager, driver, request))
      .rejects.toBeInstanceOf(DriverScheduleConflictException);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2][0]).not.toContain(driver);
    expect(query.mock.calls[2][1]).toEqual([driver, request]);
    expect(query.mock.calls[2][0]).toContain('LIMIT 1');
  });

  it('fails closed on a missing admission result without inventing a trip', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await expect(assertDriverRequestSchedule({ query } as unknown as EntityManager, 'driver', 'request'))
      .rejects.toMatchObject({ response: { code: 'DRIVER_SCHEDULE_CONFLICT' } });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
