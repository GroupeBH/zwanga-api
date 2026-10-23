import { plainToInstance } from 'class-transformer';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { validate } from 'class-validator';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminController } from '../admin/admin.controller';
import { UserRole } from '../users/entities/user.entity';
import { ResolvePayoutNotPaidDto } from './dto/resolve-payout-not-paid.dto';
import {
  isPayoutRecoveryCheckUnavailable,
  payoutRecoveryActions,
} from './payout-recovery-actions';

describe('Payout recovery API contract', () => {
  it('permits external evidence during authentication/check outages but never ignores a mismatch', () => {
    expect(isPayoutRecoveryCheckUnavailable(new BadGatewayException())).toBe(
      true,
    );
    expect(
      isPayoutRecoveryCheckUnavailable(
        new BadRequestException({ code: 'PAYOUT_SERVICE_UNAVAILABLE' }),
      ),
    ).toBe(true);
    expect(
      isPayoutRecoveryCheckUnavailable(
        new BadRequestException('Reference mismatch'),
      ),
    ).toBe(false);
    expect(
      isPayoutRecoveryCheckUnavailable(new Error('Unexpected failure')),
    ).toBe(false);
  });
  const old = {
    id: 'w',
    status: 'pending',
    createdAt: new Date(0),
    paymentTransactionId: 'p',
  };
  const payment = {
    reference: 'REF',
    provider: 'flexpay',
    status: 'pending',
  } as any;
  it('offers resolution only for an old, unresolved FlexPay withdrawal with a known reference', () => {
    expect(payoutRecoveryActions(old, payment)).toMatchObject({
      canResolveNotPaid: true,
      expectedReference: 'REF',
      resolutionRequiresProviderConfirmation: true,
    });
    expect(
      payoutRecoveryActions({ ...old, createdAt: new Date() }, payment)
        .canResolveNotPaid,
    ).toBe(false);
    expect(payoutRecoveryActions(old, null)).toMatchObject({
      canResolveNotPaid: false,
      expectedReference: null,
    });
    expect(
      payoutRecoveryActions({ ...old, paymentTransactionId: null }, null),
    ).toMatchObject({ canResolveNotPaid: true, expectedReference: 'w' });
    expect(
      payoutRecoveryActions(old, { ...payment, status: 'succeeded' })
        .canResolveNotPaid,
    ).toBe(false);
    expect(
      payoutRecoveryActions(old, { ...payment, provider: 'pawapay' })
        .canResolveNotPaid,
    ).toBe(false);
    for (const status of ['cancelled', 'failed', 'succeeded'])
      expect(
        payoutRecoveryActions({ ...old, status }, payment).canResolveNotPaid,
      ).toBe(false);
  });
  it('requires evidence and a real boolean, and bounds all operator text', async () => {
    const valid = {
      expectedReference: 'REF',
      reason: 'Not executed',
      evidenceReference: 'PROOF',
      confirmedNotPaid: true,
    };
    expect(
      await validate(plainToInstance(ResolvePayoutNotPaidDto, valid)),
    ).toHaveLength(0);
    for (const bad of [
      { confirmedNotPaid: 'true' },
      { confirmedNotPaid: false },
      { evidenceReference: ' ' },
      { reason: '' },
      { expectedReference: '' },
      { evidenceReference: 'x'.repeat(201) },
      { reason: 'x'.repeat(501) },
    ])
      expect(
        (
          await validate(
            plainToInstance(ResolvePayoutNotPaidDto, { ...valid, ...bad }),
          )
        ).length,
      ).toBeGreaterThan(0);
  });
  it('restricts the release endpoint to a super-admin with no pending password change', () => {
    const guard = new RolesGuard(new Reflector());
    const context = (role: UserRole, passwordChangeRequired = false) =>
      ({
        getClass: () => AdminController,
        getHandler: () =>
          AdminController.prototype.resolveReferralWithdrawalNotPaid,
        switchToHttp: () => ({
          getRequest: () => ({ user: { role, passwordChangeRequired } }),
        }),
      }) as any;
    for (const role of [UserRole.ADMIN, UserRole.DRIVER, UserRole.PASSENGER])
      expect(() => guard.canActivate(context(role))).toThrow();
    expect(() =>
      guard.canActivate(context(UserRole.SUPER_ADMIN, true)),
    ).toThrow();
    expect(guard.canActivate(context(UserRole.SUPER_ADMIN))).toBe(true);
  });
});
