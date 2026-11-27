import {
  assertFlexPayDepositCallbackIdentity,
  assertFlexPayDepositEvidence,
} from './flexpay-deposit-evidence';
import { PaymentTransaction } from './entities/payment-transaction.entity';
import { FlexPayTransactionStatus } from './flexpay.service';
const payment = {
  reference: 'booking-B',
  orderNumber: 'order-B',
  amount: 5000,
  currency: 'CDF',
} as PaymentTransaction;
const proof = (patch = {}) =>
  ({
    orderNumber: 'order-B',
    reference: 'booking-B',
    amount: 5000,
    currency: 'CDF',
    ...patch,
  }) as FlexPayTransactionStatus;
describe('FlexPay order binding and evidence', () => {
  it('never adopts a successful foreign order from a public callback', () => {
    expect(() =>
      assertFlexPayDepositCallbackIdentity(payment, {
        reference: 'booking-B',
        orderNumber: 'paid-order-A',
      }),
    ).toThrow();
    expect(payment.orderNumber).toBe('order-B');
  });
  it('rejects callbacks for an unbound order or a foreign merchant reference', () => {
    expect(() =>
      assertFlexPayDepositCallbackIdentity(
        { ...payment, orderNumber: null },
        { reference: payment.reference, orderNumber: 'A' },
      ),
    ).toThrow();
    expect(() =>
      assertFlexPayDepositCallbackIdentity(payment, {
        reference: 'booking-A',
        orderNumber: 'order-B',
      }),
    ).toThrow();
  });
  it.each([
    { reference: 'booking-A' },
    { orderNumber: 'order-A' },
    { amount: undefined },
    { amount: 1 },
    { amount: '5e3' },
    { currency: undefined },
    { currency: 'USD' },
    { reference: undefined },
  ])('rejects incomplete or foreign payment proof: %j', (patch) => {
    expect(() =>
      assertFlexPayDepositEvidence(payment, proof(patch), true),
    ).toThrow();
  });
  it('accepts exact server evidence and the documented order-in-reference variant', () => {
    expect(() =>
      assertFlexPayDepositEvidence(payment, proof(), true),
    ).not.toThrow();
    expect(() =>
      assertFlexPayDepositEvidence(
        payment,
        proof({ orderNumber: undefined, reference: payment.orderNumber }),
        true,
      ),
    ).not.toThrow();
  });
});
