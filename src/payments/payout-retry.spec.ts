import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminDriverPayoutRecoveryController } from '../driver-settlements/driver-payout-recovery.controller';
import { AdminController } from '../admin/admin.controller';
import { UserRole } from '../users/entities/user.entity';
import { RetryPayoutDto } from './dto/retry-payout.dto';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

describe('Payout retry public contract', () => {
  it('authenticates driver recovery routes before checking their role, even without global guards', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminDriverPayoutRecoveryController)).toEqual([JwtAuthGuard, RolesGuard]);
  });
  const proof = {
    reason: 'Non-exécution confirmée',
    evidenceReference: 'TEST-EVIDENCE',
    expectedReference: 'ORIGINAL',
    confirmedNotPaid: true,
    confirmedNotReceived: true,
  };
  it('requires both attestations and the existing provider evidence contract', () => {
    expect(validateSync(plainToInstance(RetryPayoutDto, proof))).toEqual([]);
    for (const missing of Object.keys(proof)) {
      const input = { ...proof };
      delete input[missing];
      expect(
        validateSync(plainToInstance(RetryPayoutDto, input)).length,
      ).toBeGreaterThan(0);
    }
    for (const confirmed of [false, 'true', 1, null]) {
      expect(
        validateSync(
          plainToInstance(RetryPayoutDto, {
            ...proof,
            confirmedNotReceived: confirmed,
          }),
        ).length,
      ).toBeGreaterThan(0);
      expect(
        validateSync(
          plainToInstance(RetryPayoutDto, {
            ...proof,
            confirmedNotPaid: confirmed,
          }),
        ).length,
      ).toBeGreaterThan(0);
    }
  });
  it('accepts no client-selected amount, phone, beneficiary or token quantity', () => {
    for (const field of ['amount', 'phone', 'userId', 'tokens', 'currency']) {
      expect(
        validateSync(
          plainToInstance(RetryPayoutDto, { ...proof, [field]: 'forged' }),
          {
            whitelist: true,
            forbidNonWhitelisted: true,
          },
        ).some((e) => e.property === field),
      ).toBe(true);
    }
  });
  it.each([
    [AdminDriverPayoutRecoveryController, 'retry'],
    [AdminController, 'retryReferralWithdrawal'],
  ] as const)(
    'requires super admin at the controller boundary (%s)',
    (controller, method) => {
      const guard = new RolesGuard(new Reflector());
      const context = (role: UserRole) =>
        ({
          getClass: () => controller,
          getHandler: () => controller.prototype[method],
          switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
        }) as any;
      expect(guard.canActivate(context(UserRole.SUPER_ADMIN))).toBe(true);
      for (const role of [
        UserRole.ADMIN,
        UserRole.DRIVER,
        UserRole.PASSENGER,
        UserRole.MARKETER,
      ])
        expect(() => guard.canActivate(context(role))).toThrow(
          'Insufficient permissions',
        );
    },
  );
});
