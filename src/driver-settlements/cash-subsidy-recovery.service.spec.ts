import { CashSubsidyRecoveryService } from './cash-subsidy-recovery.service';

describe('Authorised cash subsidy recovery', () => {
  const fixture = () => {
    const dataSource = { query: jest.fn().mockResolvedValue([]) };
    const settlements = { recordCompletedBookingEarning: jest.fn().mockResolvedValue({ id: 'earning' }) };
    const service = new CashSubsidyRecoveryService(dataSource as any, settlements as any);
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    return { dataSource, settlements, service };
  };

  it('selects only completed cash subsidy obligations without ANY existing credit, in bounded batches', async () => {
    const f = fixture();
    f.dataSource.query.mockResolvedValue([{ id: 'booking' }]);
    await f.service.reconcile();
    const sql = f.dataSource.query.mock.calls[0][0];
    expect(sql).toContain(`b."paymentMode" = 'cash'`);
    expect(sql).toContain('b."firstTripSubsidyApplied" = true');
    expect(sql).toContain(`b.status IN ('accepted', 'completed')`);
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM driver_earnings');
    expect(sql).toContain('LIMIT 50');
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(f.settlements.recordCompletedBookingEarning).toHaveBeenCalledWith({ id: 'booking', paymentMode: 'cash' });
  });

  it('continues after one failure and never reprices or debits the passenger', async () => {
    const f = fixture();
    f.dataSource.query.mockResolvedValue([{ id: 'invalid' }, { id: 'valid' }]);
    f.settlements.recordCompletedBookingEarning.mockRejectedValueOnce(new Error('inconsistent fare'));
    await f.service.reconcile();
    expect(f.settlements.recordCompletedBookingEarning).toHaveBeenCalledTimes(2);
    expect(f.dataSource.query).toHaveBeenCalledTimes(1);
  });

  it('rotates the cursor so permanent errors in the first batch do not starve later bookings', async () => {
    const f = fixture();
    f.dataSource.query.mockResolvedValueOnce(Array.from({ length: 50 }, (_, n) => ({ id: `id-${n}` })));
    await f.service.reconcile();
    await f.service.reconcile();
    await f.service.reconcile();
    expect(f.dataSource.query.mock.calls.map(call => call[1])).toEqual([[null], ['id-49'], [null]]);
  });

  it('prevents overlapping ticks and unlocks after a database failure', async () => {
    const f = fixture();
    let fail!: (error: Error) => void;
    f.dataSource.query.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    const first = f.service.reconcile();
    await f.service.reconcile();
    expect(f.dataSource.query).toHaveBeenCalledTimes(1);
    fail(new Error('database unavailable'));
    await first;
    await f.service.reconcile();
    expect(f.dataSource.query).toHaveBeenCalledTimes(2);
  });
});
