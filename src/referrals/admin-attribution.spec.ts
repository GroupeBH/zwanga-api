import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ReferralsService } from './referrals.service';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { ReferralProfile } from './entities/referral-profile.entity';
import { ReferralAccount } from './entities/referral-account.entity';
import { ReferralLedgerEntry } from './entities/referral-ledger-entry.entity';

describe('Administrative referral attribution', () => {
  function fixture() {
    const users = new Map<string, any>(
      ['child', 'parent', 'ancestor'].map((id) => [
        id,
        {
          id,
          firstName: id,
          isActive: true,
          status: UserStatus.ACTIVE,
        },
      ]),
    );
    const profiles = new Map<string, any>();
    const accounts = new Map<string, any>();
    const ledger: any[] = [];
    const manager = {
      query: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(false),
      findOne: jest.fn(async (entity, { where }) => {
        if (entity === User) return users.get(where.id) ?? null;
        if (entity === ReferralProfile)
          return profiles.get(where.userId) ?? [...profiles.values()].find(profile =>
            (where.code && profile.code === where.code) ||
            (where.linkToken && profile.linkToken === where.linkToken)) ?? null;
        if (entity === ReferralAccount)
          return accounts.get(where.userId) ?? null;
        if (entity === ReferralLedgerEntry)
          return (
            ledger.find(
              (entry) =>
                entry.userId === where.userId &&
                entry.sourceEntityId === where.sourceEntityId,
            ) ?? null
          );
        return null;
      }),
      create: jest.fn((entity, data) => Object.assign(new entity(), data)),
      save: jest.fn(async (entity) => {
        if (entity instanceof ReferralProfile)
          profiles.set(entity.userId, entity);
        if (entity instanceof ReferralAccount)
          accounts.set(entity.userId, entity);
        if (entity instanceof ReferralLedgerEntry) ledger.push(entity);
        return entity;
      }),
    };
    const admin = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'admin', role: UserRole.SUPER_ADMIN }),
    };
    const notifications = { sendNotification: jest.fn() };
    const source = { transaction: jest.fn((callback) => callback(manager)) };
    const service = new ReferralsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      admin as any,
      {} as any,
      {} as any,
      source as any,
      { get: jest.fn(key => key === 'REFERRAL_ATTRIBUTION_BONUS_TOKENS' ? 500 : undefined) } as any,
      {} as any,
      {} as any,
      notifications as any,
    );
    return {
      service,
      users,
      profiles,
      accounts,
      ledger,
      manager,
      admin,
      source,
      notifications,
    };
  }
  const reason = 'Rattachement validé avec le support';

  it('records the admin attribution without a bonus, even with legacy bonus configuration', async () => {
    const f = fixture();
    const before = Date.now();
    const first = await f.service.attachUserByAdmin(
      'admin',
      'child',
      'parent',
      reason,
    );
    expect(first).toMatchObject({
      attached: true,
      newlyAttached: true,
      attributionBonusTokens: 0,
    });
    expect(f.profiles.get('child')).toMatchObject({
      referredByUserId: 'parent',
      attributionProvider: 'admin',
      qualifiedAt: null,
      rewardWindowEndsAt: null,
      attributionAdminId: 'admin',
      attributionAdminReason: reason,
    });
    expect(f.profiles.get('child').referredAt.getTime()).toBeGreaterThanOrEqual(
      before,
    );
    expect(f.accounts.has('parent')).toBe(false);
    expect(f.accounts.get('child').availableTokens).toBe(0);
    expect(f.ledger).toHaveLength(0);
    const referredAt = first.referredAt;
    const repeat = await f.service.attachUserByAdmin(
      'admin',
      'child',
      'parent',
      'Un nouveau motif ne remplace pas le premier audit',
    );
    expect(repeat).toMatchObject({
      newlyAttached: false,
      attributionBonusTokens: 0,
      referredAt,
    });
    expect(f.ledger).toHaveLength(0);
    expect(f.accounts.has('parent')).toBe(false);
    expect(f.profiles.get('child').attributionAdminReason).toBe(reason);
    expect(f.notifications.sendNotification).not.toHaveBeenCalled(); // No current FCM token.
  });

  it.each(['code', 'token', 'transaction'] as const)(
    'registers by %s without credit and sends only an informational notification after commit',
    async mode => {
      const f = fixture();
      f.users.get('parent').fcmToken = 'synthetic-token';
      f.profiles.set('parent', { userId: 'parent', code: 'ZWPARENT', linkToken: 'parent-link-token-abcdefghijklmnopqrstuvwxyz' });
      const attribution = mode === 'code'
        ? { referralCode: 'ZWPARENT' }
        : { referralToken: 'parent-link-token-abcdefghijklmnopqrstuvwxyz', referralCapturedAt: new Date().toISOString() };
      if (mode === 'transaction') {
        const afterCommit = await f.service.registerUserInTransaction(f.manager as any, 'child', attribution);
        expect(f.notifications.sendNotification).not.toHaveBeenCalled();
        await afterCommit();
      } else {
        await f.service.registerUser('child', attribution);
      }
      expect(f.profiles.get('child')).toMatchObject({
        referredByUserId: 'parent', qualifiedAt: null, rewardWindowEndsAt: null,
        attributionAdminId: null, attributionAdminReason: null,
      });
      expect(f.accounts.has('parent')).toBe(false);
      expect(f.ledger).toHaveLength(0);
      expect(f.notifications.sendNotification).toHaveBeenCalledTimes(1);
      expect(f.notifications.sendNotification.mock.calls[0][2]).not.toMatch(/recevez.*jetons/);
      await f.service.registerUser('child', attribution);
      expect(f.notifications.sendNotification).toHaveBeenCalledTimes(1);
      expect(f.ledger).toHaveLength(0);
    },
  );

  it('preserves previously credited signup bonuses and existing account buckets', async () => {
    const f = fixture();
    const historical = { userId: 'parent', sourceEntityId: 'ancestor', type: 'attribution_bonus', amountTokens: 5 };
    const balances = { userId: 'parent', availableTokens: 1005, pendingTokens: 20, reservedTokens: 1000, withdrawnTokens: 2000 };
    f.ledger.push(historical);
    f.accounts.set('parent', { ...balances });
    await f.service.attachUserByAdmin('admin', 'child', 'parent', reason);
    expect(f.accounts.get('parent')).toEqual(balances);
    expect(f.ledger).toEqual([historical]);
  });

  it.each([UserRole.PASSENGER, UserRole.DRIVER])(
    'rejects the unauthorized role %s before any transaction',
    async (role) => {
      const f = fixture();
      f.admin.findOne.mockResolvedValue({ role } as any);
      await expect(
        f.service.attachUserByAdmin('admin', 'child', 'parent', reason),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.source.transaction).not.toHaveBeenCalled();
    },
  );

  it.each(['court', ' '.repeat(20), 'x'.repeat(301)])(
    'rejects an invalid audit reason',
    async (invalid) => {
      const f = fixture();
      await expect(
        f.service.attachUserByAdmin('admin', 'child', 'parent', invalid),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.source.transaction).not.toHaveBeenCalled();
    },
  );

  it('rejects self-referral without writing anything', async () => {
    const f = fixture();
    await expect(
      f.service.attachUserByAdmin('admin', 'child', 'child', reason),
    ).rejects.toThrow('propre code');
    expect(f.manager.save).not.toHaveBeenCalled();
  });

  it('never replaces an existing parent', async () => {
    const f = fixture();
    f.profiles.set('child', { userId: 'child', referredByUserId: 'ancestor' });
    await expect(
      f.service.attachUserByAdmin('admin', 'child', 'parent', reason),
    ).rejects.toThrow('ne peut pas être modifié');
    expect(f.manager.save).not.toHaveBeenCalled();
  });

  it.each([UserStatus.INACTIVE, UserStatus.SUSPENDED])(
    'rejects an unavailable parent (%s)',
    async (status) => {
      const f = fixture();
      f.users.get('parent').status = status;
      await expect(
        f.service.attachUserByAdmin('admin', 'child', 'parent', reason),
      ).rejects.toThrow('invalide ou inactif');
      expect(f.manager.save).not.toHaveBeenCalled();
    },
  );

  it('rejects missing users and missing parents', async () => {
    const f = fixture();
    await expect(
      f.service.attachUserByAdmin('admin', 'missing', 'parent', reason),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      f.service.attachUserByAdmin('admin', 'child', 'missing', reason),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.manager.save).not.toHaveBeenCalled();
  });

  it('rejects an indirect cycle under the graph lock without creating a bonus', async () => {
    const f = fixture();
    f.profiles.set('parent', {
      userId: 'parent',
      referredByUserId: 'ancestor',
    });
    f.profiles.set('ancestor', {
      userId: 'ancestor',
      referredByUserId: 'child',
    });
    await expect(
      f.service.attachUserByAdmin('admin', 'child', 'parent', reason),
    ).rejects.toThrow('boucle');
    expect(f.manager.query.mock.calls[0][1]).toEqual([
      'zwanga:referral-attribution',
    ]);
    expect(f.manager.save).not.toHaveBeenCalled();
  });
});
