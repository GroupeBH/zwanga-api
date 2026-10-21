import { ReferralBookingReconciliationService } from './referral-booking-reconciliation.service';

describe('referral reward recovery failure isolation', () => {
  function fixture() {
    const query = jest.fn().mockResolvedValueOnce([[{ bookingId: 'first', attempts: 1, revision: 3 }, { bookingId: 'second', attempts: 2, revision: 1 }], 2])
      .mockResolvedValue([[], 1]);
    const source = { query, getRepository: () => ({ findOneByOrFail: async ({ id }: { id: string }) => ({ id }) }) };
    const awardBookingReward = jest.fn().mockResolvedValue(null);
    const worker = new ReferralBookingReconciliationService(source as any, { awardBookingReward } as any);
    jest.spyOn((worker as any).logger, 'warn').mockImplementation(() => undefined);
    return { query, worker, awardBookingReward };
  }
  it('continues the batch after one failed credit, retaining that job for retry', async () => {
    const f = fixture();
    f.awardBookingReward.mockRejectedValueOnce(new Error('synthetic'));
    await f.worker.reconcile();
    expect(f.awardBookingReward).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls[1][1]).toEqual(['first', expect.any(String), false, 3, 120]);
    expect(f.query.mock.calls[2][1]).toEqual(['second', expect.any(String), true, 1, 240]);
    expect(f.query.mock.calls[1][0]).toContain('revision = $4');
    expect(f.query.mock.calls[1][0]).toContain('"leaseToken" = $2');
  });
  it('does not abort other rewards after losing a committed credit acknowledgement', async () => {
    const f = fixture();
    f.query.mockRejectedValueOnce(new Error('synthetic ACK unavailable'));
    await f.worker.reconcile();
    expect(f.awardBookingReward).toHaveBeenCalledTimes(2);
    expect(f.query).toHaveBeenCalledTimes(3);
    expect(f.query.mock.calls[0][0]).toContain('"leaseUntil" < now()');
  });
});
