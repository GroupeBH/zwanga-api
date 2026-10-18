import { hasCurrentApprovedIdentity } from './current-identity';

describe('current KYC authorization', () => {
  it.each(['approved', 'rejected', 'pending', null])('uses only the latest dossier: %s', async status => {
    const findOne = jest.fn().mockResolvedValue(status ? { id: 'latest', status } : null);
    expect(await hasCurrentApprovedIdentity({ findOne }, 'user')).toBe(status === 'approved');
    expect(findOne).toHaveBeenCalledWith({ where: { userId: 'user' },
      order: { createdAt: 'DESC', id: 'DESC' }, select: { id: true, status: true } });
  });
});
