import { CashRestrictionRetirementService } from './cash-restriction-retirement.service';
import { UserStatus } from '../users/entities/user.entity';

describe('safe deferred cash restriction retirement', () => {
  function fixture() {
    const query = jest
      .fn<Promise<{ driverId: string }[]>, [string]>()
      .mockResolvedValue([]);
    const check = jest.fn().mockResolvedValue([{ busy: false }]);
    const changes = jest.fn();
    const deactivate = jest.fn(
      async (
        _id: string,
        _status: UserStatus,
        change: (manager: unknown) => Promise<void>,
        guard: (manager: unknown) => Promise<void>,
      ) => {
        await guard({ query: check });
        await change({ query: changes });
      },
    );
    const worker = new CashRestrictionRetirementService(
      { query } as never,
      { deactivate } as never,
    );
    return { query, check, changes, deactivate, worker };
  }
  it('only selects settled accounts, no ongoing ride, keeping unresolved cash and electronic payments pending', async () => {
    const f = fixture();
    await f.worker.retireSettledAccounts();
    const sql = f.query.mock.calls[0][0];
    expect(sql).toContain("t.status='ongoing'");
    expect(sql).toContain('b."cashReceivedAt" IS NULL');
    expect(sql).toContain('b."paymentStatus" IS DISTINCT FROM \'succeeded\'');
    expect(sql).toContain('LIMIT 10');
    expect(f.deactivate).not.toHaveBeenCalled();
  });
  it('rechecks after lifecycle locks, then retires through the existing safe lifecycle', async () => {
    const f = fixture();
    f.query.mockResolvedValue([{ driverId: 'driver' }]);
    await f.worker.retireSettledAccounts();
    expect(f.deactivate).toHaveBeenCalledWith(
      'driver',
      UserStatus.SUSPENDED,
      expect.any(Function),
      expect.any(Function),
    );
    expect(f.check).toHaveBeenCalledWith(expect.stringContaining('AS busy'), [
      'driver',
    ]);
    expect(f.changes).toHaveBeenCalledWith(
      expect.stringContaining('COALESCE("deactivatedAt",now())'),
      ['driver'],
    );
  });
  it('never changes the account if a ride/payment becomes unfinished between selection and locking', async () => {
    const f = fixture();
    f.query.mockResolvedValue([{ driverId: 'driver' }]);
    f.check.mockResolvedValue([{ busy: true }]);
    await f.worker.retireSettledAccounts();
    expect(f.changes).not.toHaveBeenCalled();
    f.check.mockResolvedValue([{ busy: false }]);
    await f.worker.retireSettledAccounts();
    expect(f.changes).toHaveBeenCalledTimes(1);
  });
  it('handles worker overlap and releases its running guard after an error', async () => {
    const f = fixture();
    let reject!: (reason: Error) => void;
    f.query.mockImplementationOnce(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    const pending = f.worker.retireSettledAccounts();
    await f.worker.retireSettledAccounts();
    expect(f.query).toHaveBeenCalledTimes(1);
    reject(new Error('fixture'));
    await pending;
    await f.worker.retireSettledAccounts();
    expect(f.query).toHaveBeenCalledTimes(2);
  });
});
