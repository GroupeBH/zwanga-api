import { payoutRetryAvailability } from './payout-retry-availability';
import { PayoutRetryKind } from './entities/payout-retry.entity';
import { PAYOUT_RELEASE_GRACE_MS } from './payout-recovery-actions';
import { PayoutRecoveryListDto } from '../driver-settlements/dto/driver-payout-recovery.dto';
import { validateSync } from 'class-validator';

describe.each<PayoutRetryKind>(['driver_payout', 'referral_withdrawal'])('%s retry capability', kind => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  const source = {
    id: 'withdrawal', status: 'pending', driverId: 'user', userId: 'user', amount: 10000,
    currency: 'CDF', phone: '+243891234567', paymentTransactionId: 'payment',
    createdAt: new Date(now - PAYOUT_RELEASE_GRACE_MS), requestedAt: null,
  } as any;
  const payment = {
    id: 'payment', userId: 'user', relatedEntityType: kind, relatedEntityId: source.id,
    purpose: kind === 'driver_payout' ? 'driver_payout' : 'referral_payout',
    provider: 'flexpay', status: 'pending', amount: 10000, currency: 'CDF', phone: '243891234567',
  } as any;
  const check = (patch = {}, paymentPatch = {}, replacement = false) =>
    payoutRetryAvailability(kind, { ...source, ...patch }, { ...payment, ...paymentPatch }, replacement, now);

  it.each(['pending', 'initiated', 'failed', 'cancelled'])('allows %s only as a capability, with proof required', status => {
    expect(check({ status })).toMatchObject({ canAdminRetry: true, adminRetry: { code: 'AVAILABLE' } });
  });
  it('returns a precise safety deadline without claiming an eventual payment failure', () => {
    expect(check({ requestedAt: new Date(now - 1000) })).toMatchObject({
      canAdminRetry: false, adminRetry: { code: 'SAFETY_DELAY', availableAt: new Date(now + PAYOUT_RELEASE_GRACE_MS - 1000).toISOString() },
    });
    expect(check({ createdAt: new Date('invalid') }).adminRetry.code).toBe('INVALID_STATE');
  });
  it('supports a never-submitted reservation but blocks a missing linked transaction', () => {
    expect(payoutRetryAvailability(kind, { ...source, paymentTransactionId: null }, null, false, now).canAdminRetry).toBe(true);
    expect(payoutRetryAvailability(kind, source, null, false, now).adminRetry.code).toBe('PAYMENT_MISMATCH');
  });
  it('explains already-paid, incident and replacement states', () => {
    expect(check({ status: 'succeeded' }).adminRetry.code).toBe('ALREADY_PAID');
    expect(check({}, { status: 'succeeded' }).adminRetry.code).toBe('ALREADY_PAID');
    expect(check({ recoveryBlocked: true }).adminRetry.code).toBe('RECOVERY_BLOCKED');
    expect(check({}, {}, true).adminRetry.code).toBe('ALREADY_RETRIED');
    expect(check({}, { provider: 'pawapay' }).adminRetry.code).toBe('UNSUPPORTED_PROVIDER');
  });
  it.each([{ id: 'wrong' }, { userId: 'other' }, { amount: 20000 }, { currency: 'USD' },
    { phone: '243891234568' }, { purpose: 'topup' }, { relatedEntityId: 'other' }, { relatedEntityType: 'other' }])('blocks an inconsistent payment %j', patch => {
    expect(check({}, patch)).toMatchObject({ canAdminRetry: false, adminRetry: { code: 'PAYMENT_MISMATCH' } });
  });
});

it('validates the optional recovery view without changing legacy pagination', () => {
  for (const view of [undefined, 'review', 'pending', 'resolved'])
    expect(validateSync(Object.assign(new PayoutRecoveryListDto(), { view }))).toHaveLength(0);
  expect(validateSync(Object.assign(new PayoutRecoveryListDto(), { view: 'arbitrary' }))).not.toHaveLength(0);
});
