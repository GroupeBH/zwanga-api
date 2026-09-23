import { hasVerifiedWalletTopUpProof } from './wallet-topup-proof';
import { PaymentTransaction } from './entities/payment-transaction.entity';

const payment = () =>
  ({
    purpose: 'wallet_top_up',
    status: 'succeeded',
    userId: 'user',
    relatedEntityType: 'wallet_top_up',
    relatedEntityId: 'user',
    amount: '5000.00',
    currency: 'CDF',
    reference: 'WAL123',
    orderNumber: 'ORDER',
    rawCheckResponse: {
      code: '0',
      transaction: {
        status: '0',
        reference: 'WAL123',
        orderNumber: 'ORDER',
        amount: '5000',
        currency: 'CDF',
      },
    },
  }) as unknown as PaymentTransaction;

describe('cash-redeemable wallet purchase proof', () => {
  it('accepts complete provider proof, including documented casing and order-as-reference', () => {
    expect(hasVerifiedWalletTopUpProof(payment())).toBe(true);
    expect(
      hasVerifiedWalletTopUpProof({
        ...payment(),
        rawCheckResponse: {
          Code: 0,
          Transaction: {
            Status: 0,
            reference: 'ORDER',
            orderNumber: 'ORDER',
            amount: 5000,
            currency: 'cdf',
          },
        },
      }),
    ).toBe(true);
  });
  it.each([null, {}, { code: '0' }, { code: '0', transaction: {} }])(
    'rejects missing proof %p',
    (rawCheckResponse) => {
      expect(
        hasVerifiedWalletTopUpProof({ ...payment(), rawCheckResponse }),
      ).toBe(false);
    },
  );
  it.each([
    { amount: '1' },
    { currency: 'USD' },
    { reference: 'OTHER' },
    { orderNumber: 'OTHER' },
    { status: '1' },
    { amount: '' },
    { amount: null },
    { amount: 'Infinity' },
    { currency: '' },
  ])('rejects mismatched provider values %p', (patch) => {
    const value = payment();
    const tx = value.rawCheckResponse!.transaction as Record<string, unknown>;
    value.rawCheckResponse = { code: '0', transaction: { ...tx, ...patch } };
    expect(hasVerifiedWalletTopUpProof(value)).toBe(false);
  });
  it.each([
    { purpose: 'trip_booking' },
    { userId: 'other' },
    { relatedEntityId: null },
    { orderNumber: null },
    { status: 'initiated' },
  ])('rejects invalid local ownership/status %p', (patch) => {
    expect(
      hasVerifiedWalletTopUpProof({
        ...payment(),
        ...patch,
      } as PaymentTransaction),
    ).toBe(false);
  });
});
