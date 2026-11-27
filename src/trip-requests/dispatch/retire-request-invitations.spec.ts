import { retireRequestInvitations, RETIRE_REQUEST_INVITATIONS_SQL } from './retire-request-invitations';

describe('request-scoped invitation retirement', () => {
  it('performs all retirement checks in one statement even when nothing expires', async () => {
    const manager = { query: jest.fn().mockResolvedValueOnce([]) };
    expect(await retireRequestInvitations(manager as never, 'request', false)).toBe(false);
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenCalledWith(RETIRE_REQUEST_INVITATIONS_SQL, ['request', false]);
    expect(RETIRE_REQUEST_INVITATIONS_SQL).toContain('UNION SELECT id FROM cancelled');
  });

  it('cleans earlier rejected offers too and reports committed expiration candidates', async () => {
    const manager = { query: jest.fn().mockResolvedValueOnce([{ id: 'invitation', driverId: 'driver' }]) };
    const released = ['previous'];
    expect(await retireRequestInvitations(manager as never, 'request', true, released)).toBe(true);
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenCalledWith(RETIRE_REQUEST_INVITATIONS_SQL, ['request', true]);
    expect(released).toEqual(['previous', 'driver']);
  });

  it('propagates cleanup errors so the enclosing SQL transaction can roll back', async () => {
    const failure = Object.assign(new Error('timeout'), { code: '57014' });
    const manager = { query: jest.fn().mockRejectedValueOnce(failure) };
    const released: string[] = [];
    await expect(retireRequestInvitations(manager as never, 'request', false, released)).rejects.toBe(failure);
    expect(released).toEqual([]);
    expect(manager.query).toHaveBeenCalledTimes(1);
  });
});
