import { retireRequestInvitations, RETIRE_COUNTEROFFER_NOTIFICATIONS_SQL, RETIRE_REQUEST_NOTIFICATIONS_SQL } from './retire-request-invitations';

describe('request-scoped invitation retirement', () => {
  it('does not scan counteroffer notifications when the request has no closed counteroffers', async () => {
    const manager = { query: jest.fn().mockResolvedValueOnce([[], 0]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([[], 0]).mockResolvedValueOnce([[], 0]) };
    expect(await retireRequestInvitations(manager as never, 'request', false)).toBe(false);
    expect(manager.query).toHaveBeenCalledTimes(4);
    expect(manager.query.mock.calls.some(([sql]) => sql === RETIRE_COUNTEROFFER_NOTIFICATIONS_SQL)).toBe(false);
    expect(manager.query).toHaveBeenLastCalledWith(RETIRE_REQUEST_NOTIFICATIONS_SQL, ['request', false]);
  });

  it('cleans earlier rejected offers too and reports committed expiration candidates', async () => {
    const manager = { query: jest.fn().mockResolvedValueOnce([[], 0]).mockResolvedValueOnce([{ id: 'old-offer' }])
      .mockResolvedValueOnce([[], 1]).mockResolvedValueOnce([[{ id: 'invitation' }], 1]).mockResolvedValueOnce([[], 1]) };
    expect(await retireRequestInvitations(manager as never, 'request', true)).toBe(true);
    expect(manager.query).toHaveBeenNthCalledWith(3, RETIRE_COUNTEROFFER_NOTIFICATIONS_SQL, ['request', ['old-offer']]);
    expect(manager.query.mock.calls[3][1]).toEqual(['request', 'cancelled', true]);
  });

  it('propagates cleanup errors so the enclosing SQL transaction can roll back', async () => {
    const failure = Object.assign(new Error('timeout'), { code: '57014' });
    const manager = { query: jest.fn().mockResolvedValueOnce([[], 0]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([[{ id: 'invitation' }], 1]).mockRejectedValueOnce(failure) };
    await expect(retireRequestInvitations(manager as never, 'request', false)).rejects.toBe(failure);
  });
});
