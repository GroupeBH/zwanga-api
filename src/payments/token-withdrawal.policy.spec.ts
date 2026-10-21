import { PaymentPurpose } from './entities/payment-transaction.entity';
import {
  assertPayoutPurposeAllowed,
  TOKEN_WITHDRAWAL_DISABLED,
} from './token-withdrawal.policy';

describe('token withdrawal policy', () => {
  it.each([
    {},
    { purpose: PaymentPurpose.DRIVER_PAYOUT },
    {
      purpose: PaymentPurpose.DRIVER_PAYOUT,
      relatedEntityType: 'driver_payout',
    },
    { relatedEntityType: 'driver_payout' },
    {
      purpose: PaymentPurpose.REFERRAL_PAYOUT,
      relatedEntityType: 'referral_withdrawal',
      relatedEntityId: 'withdrawal',
      amount: 10000,
      currency: 'CDF',
    },
  ])('preserves the driver earnings payout contract: %j', (input) => {
    expect(() => assertPayoutPurposeAllowed(input)).not.toThrow();
  });

  it.each([
    { purpose: PaymentPurpose.WALLET_PAYOUT },
    { purpose: PaymentPurpose.REFERRAL_PAYOUT },
    { purpose: 'unknown' },
    {
      purpose: PaymentPurpose.WALLET_PAYOUT,
      relatedEntityType: 'driver_payout',
    },
    {
      purpose: PaymentPurpose.REFERRAL_PAYOUT,
      relatedEntityType: 'driver_payout',
    },
    {
      purpose: PaymentPurpose.DRIVER_PAYOUT,
      relatedEntityType: 'wallet_withdrawal',
    },
    {
      purpose: PaymentPurpose.DRIVER_PAYOUT,
      relatedEntityType: 'referral_withdrawal',
    },
    { relatedEntityType: 'wallet_withdrawal' },
    { relatedEntityType: 'referral_withdrawal' },
    {
      purpose: PaymentPurpose.REFERRAL_PAYOUT,
      relatedEntityType: 'referral_withdrawal',
      relatedEntityId: 'withdrawal',
      amount: 9999.9,
      currency: 'CDF',
    },
    {
      purpose: PaymentPurpose.REFERRAL_PAYOUT,
      relatedEntityType: 'referral_withdrawal',
      relatedEntityId: 'withdrawal',
      amount: 25000,
      currency: 'USD',
    },
    {
      purpose: PaymentPurpose.REFERRAL_PAYOUT,
      relatedEntityType: 'referral_withdrawal',
      amount: 25000,
      currency: 'CDF',
    },
  ])('refuses token or unrecognized payout sources: %j', (input) => {
    let error: unknown;
    try {
      assertPayoutPurposeAllowed(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      status: 403,
      response: TOKEN_WITHDRAWAL_DISABLED,
    });
  });
});
