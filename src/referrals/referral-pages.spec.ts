import { BadRequestException } from '@nestjs/common';
import { ReferralsService } from './referrals.service';

const ids = [3, 2, 1].map(n => `00000000-0000-4000-8000-00000000000${n}`);
const rows = ids.map(id => ({ id, at: '2026-10-03T12:00:00.123456' }));
function query() {
  const qb: any = {};
  for (const key of ['where', 'andWhere', 'select', 'addSelect', 'orderBy', 'addOrderBy', 'limit']) {
    qb[key] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

describe('bounded referral pages', () => {
  for (const [method, repository, reader, alias, owner] of [
    ['getReferralPage', 'profileRepository', 'getReferrals', 'profile', 'referredByUserId'],
    ['getRewardPage', 'rewardRepository', 'getRewards', 'reward', 'referrerUserId'],
    ['getWithdrawalPage', 'withdrawalRepository', 'getWithdrawals', 'withdrawal', 'userId'],
  ]) {
    it(`${method}: bounds IDs before hydration, scopes the owner and keeps cursor order`, async () => {
      const service: any = Object.create(ReferralsService.prototype);
      const qb = query();
      const records = ids.slice(0, 2).reverse().map(id => ({ id, userId: `user-${id}`, earnings: { earnedTokens: 7 } }));
      service[repository] = { createQueryBuilder: jest.fn(() => qb), find: jest.fn().mockResolvedValue(records) };
      service[reader] = jest.fn().mockResolvedValue(records);
      const first = await service[method]('owner', { limit: 2 });
      expect(qb.where).toHaveBeenCalledWith(`${alias}.${owner} = :userId`, { userId: 'owner' });
      expect(qb.limit).toHaveBeenCalledWith(3);
      expect(service[reader]).toHaveBeenCalledWith('owner', ids.slice(0, 2));
      expect(first.data.map((row: any) => row.id)).toEqual(ids.slice(0, 2));
      expect(first.data[0].earnings.earnedTokens).toBe(7);
      expect(first.nextCursor).toEqual(expect.any(String));
      if (method === 'getReferralPage') {
        expect(service[repository].find).toHaveBeenCalledWith(expect.objectContaining({
          where: expect.objectContaining({ referredByUserId: 'owner', id: expect.objectContaining({ _value: ids.slice(0, 2) }) }),
        }));
      }
      qb.getRawMany.mockResolvedValue([rows[2]]);
      service[reader].mockResolvedValue([{ id: ids[2], userId: `user-${ids[2]}` }]);
      service[repository].find.mockResolvedValue([{ id: ids[2], userId: `user-${ids[2]}` }]);
      const second = await service[method]('owner', { limit: 2, before: first.nextCursor });
      expect(qb.andWhere).toHaveBeenCalledWith(expect.stringContaining(':cursorId::uuid'),
        { at: rows[1].at, cursorId: ids[1] });
      expect(second.nextCursor).toBeNull();
      expect(second.data.map((row: any) => row.id)).toEqual([ids[2]]);
      qb.getRawMany.mockResolvedValue([]);
      service[reader].mockClear();
      expect(await service[method]('owner', { limit: 2 })).toEqual({ data: [], nextCursor: null });
      expect(service[reader]).not.toHaveBeenCalled();
      qb.getRawMany.mockClear();
      await expect(service[method]('owner', { before: 'invalid' })).rejects.toBeInstanceOf(BadRequestException);
      expect(qb.getRawMany).not.toHaveBeenCalled();
    });
  }
});
