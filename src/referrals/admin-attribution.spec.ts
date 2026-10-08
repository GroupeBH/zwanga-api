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
          return profiles.get(where.userId) ?? null;
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
      { get: jest.fn() } as any,
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

  it('creates missing profiles/accounts, records an admin audit and grants the usual bonus only once', async () => {
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
      attributionBonusTokens: 5,
    });
    expect(f.profiles.get('child')).toMatchObject({
      referredByUserId: 'parent',
      attributionProvider: 'admin',
      qualifiedAt: null,
      rewardWindowEndsAt: null,
    });
    expect(f.profiles.get('child').referredAt.getTime()).toBeGreaterThanOrEqual(
      before,
    );
    expect(f.accounts.get('parent').availableTokens).toBe(5);
    expect(f.ledger).toHaveLength(1);
    expect(f.ledger[0]).toMatchObject({
      sourceEntityId: 'child',
      type: 'attribution_bonus',
      description: `Bonus de 5 jetons ; filleul child ; admin admin : ${reason}`,
    });
    const referredAt = first.referredAt;
    const repeat = await f.service.attachUserByAdmin(
      'admin',
      'child',
      'parent',
      reason,
    );
    expect(repeat).toMatchObject({
      newlyAttached: false,
      attributionBonusTokens: 0,
      referredAt,
    });
    expect(f.ledger).toHaveLength(1);
    expect(f.accounts.get('parent').availableTokens).toBe(5);
    expect(f.notifications.sendNotification).not.toHaveBeenCalled(); // The ledger outbox owns the push.
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
