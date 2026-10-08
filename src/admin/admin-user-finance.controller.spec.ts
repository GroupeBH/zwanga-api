import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminController } from './admin.controller';
import { AdminAttachReferrerDto } from './dto/admin-referral.dto';
import { UserRole } from '../users/entities/user.entity';
import { ROLES_KEY } from '../common/guards/roles.guard';

describe('Admin user financial actions contract', () => {
  it('allows admins and super-admins to adjust tokens and attach referrals', () => {
    for (const method of [
      'adjustWallet',
      'attachUserReferrer',
      'searchReferrers',
    ] as const) {
      expect(
        Reflect.getMetadata(ROLES_KEY, AdminController.prototype[method]),
      ).toEqual([UserRole.ADMIN]);
    }
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.getUserFinancialSummary,
      ),
    ).toEqual([UserRole.ADMIN]);
  });
  it('uses the authenticated actor rather than any actor supplied by the client', async () => {
    const referrals = {
      attachReferrer: jest.fn().mockResolvedValue({ newlyAttached: true }),
    };
    const controller = new AdminController({} as any, referrals as any);
    const dto = {
      referrerUserId: 'parent',
      reason: 'Correction après vérification',
    };
    await controller.attachUserReferrer(
      { user: { userId: 'actor-from-jwt' } },
      'child',
      dto,
    );
    expect(referrals.attachReferrer).toHaveBeenCalledWith(
      'actor-from-jwt',
      'child',
      dto.referrerUserId,
      dto.reason,
    );
  });
  it('rejects invalid parent IDs and whitespace-only reasons', async () => {
    expect(
      (
        await validate(
          plainToInstance(AdminAttachReferrerDto, {
            referrerUserId: 'not-uuid',
            reason: ' '.repeat(20),
          }),
        )
      ).length,
    ).toBe(2);
    expect(
      await validate(
        plainToInstance(AdminAttachReferrerDto, {
          referrerUserId: '123e4567-e89b-12d3-a456-426614174000',
          reason: '  Rattachement validé par le support  ',
        }),
      ),
    ).toEqual([]);
  });
});
