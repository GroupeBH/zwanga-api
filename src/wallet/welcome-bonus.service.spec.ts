import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { WelcomeBonusService } from './welcome-bonus.service';
import { CronExpression } from '@nestjs/schedule';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

describe('WelcomeBonusService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('registers one named non-overlapping cron every minute', () => {
    expect(
      Reflect.getMetadata(
        SCHEDULE_CRON_OPTIONS,
        WelcomeBonusService.prototype.backfillEligibleAccounts,
      ),
    ).toMatchObject({
      name: 'welcome-bonus-catch-up',
      cronTime: CronExpression.EVERY_MINUTE,
      waitForCompletion: true,
    });
  });

  function setup() {
    const query = jest.fn().mockResolvedValue([{ credited: 2 }]);
    const transaction = jest.fn(
      (work: (manager: EntityManager) => Promise<unknown>) =>
        work({ query } as unknown as EntityManager),
    );
    const service = new WelcomeBonusService({
      transaction,
    } as unknown as DataSource);
    return { query, transaction, service };
  }

  it('uses one bounded transaction and reports committed credits', async () => {
    const { service, query, transaction } = setup();
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    await service.backfillEligibleAccounts();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query.mock.calls).toEqual([
      ["SET LOCAL lock_timeout = '2s'"],
      ["SET LOCAL statement_timeout = '15s'"],
      ['SELECT zwanga_backfill_welcome_bonus($1) AS credited', [100]],
    ]);
    expect(log).toHaveBeenCalledWith('Welcome bonus: 2 accounts credited');
  });

  it('retries the next tick after rollback without claiming credits succeeded', async () => {
    const { service, query } = setup();
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    query.mockRejectedValueOnce(new Error('lock timeout'));
    await expect(service.backfillEligibleAccounts()).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    await service.backfillEligibleAccounts();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('is silent when catch-up is complete', async () => {
    const { service, query } = setup();
    query.mockResolvedValue([{ credited: 0 }]);
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    await service.backfillEligibleAccounts();
    expect(log).not.toHaveBeenCalled();
  });
});
