import {
  claimDriverPayoutPayment,
  commitFlexPayPayoutState,
} from './flexpay-payout-state';
import { DriverPayout } from '../driver-settlements/entities/driver-payout.entity';
import { PaymentTransaction } from './entities/payment-transaction.entity';
import { User } from '../users/entities/user.entity';

describe('FlexPay payout durable state', () => {
  let current: any, payout: any, repository: any, manager: any;
  beforeEach(() => {
    current = {
      id: 'payment',
      userId: 'driver',
      reference: 'REF',
      orderNumber: 'ORDER',
      purpose: 'driver_payout',
      relatedEntityType: 'driver_payout',
      relatedEntityId: 'payout',
      provider: 'flexpay',
      amount: 9500,
      currency: 'CDF',
      status: 'pending',
    };
    payout = {
      id: 'payout',
      driverId: 'driver',
      amount: 9500,
      currency: 'CDF',
      status: 'pending',
    };
    manager = {
      findOne: jest.fn(async (entity) =>
        entity === User
          ? { id: 'driver' }
          : entity === DriverPayout
            ? { ...payout }
            : current
              ? { ...current }
              : null,
      ),
      save: jest.fn(async (entity, value) => {
        if (entity === DriverPayout) payout = { ...value };
        else current = { ...value };
        return value;
      }),
    };
    repository = { manager: { transaction: async (work) => work(manager) } };
  });

  it.each(['pending', 'initiated', 'failed', 'cancelled'])(
    'does not downgrade succeeded to %s',
    async (status) => {
      const stale = { ...current, status };
      current.status = 'succeeded';
      expect((await commitFlexPayPayoutState(repository, stale)).status).toBe(
        'succeeded',
      );
      expect(manager.save).not.toHaveBeenCalled();
    },
  );

  it('does retain verified success after a previous failure for recovery handling', async () => {
    current.status = 'failed';
    expect(
      (
        await commitFlexPayPayoutState(repository, {
          ...current,
          status: 'succeeded',
        })
      ).status,
    ).toBe('succeeded');
  });

  it('rejects a different provider order rather than rebinding a payment', async () => {
    await expect(
      commitFlexPayPayoutState(repository, {
        ...current,
        orderNumber: 'OTHER',
      }),
    ).rejects.toThrow();
  });

  it('reuses a durable submission, never creating another payment', async () => {
    const result = await claimDriverPayoutPayment(repository, {
      ...current,
      id: 'second',
    });
    expect(result).toMatchObject({
      created: false,
      payment: { id: 'payment' },
    });
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('cannot create a payment after an unsent reservation was cancelled', async () => {
    const draft = { ...current };
    current = null;
    payout.status = 'cancelled';
    await expect(claimDriverPayoutPayment(repository, draft)).rejects.toThrow();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('creates the payment and attaches it to its reservation atomically', async () => {
    const draft = { ...current };
    current = null;
    const result = await claimDriverPayoutPayment(repository, draft);
    expect(result.created).toBe(true);
    expect(payout.paymentTransactionId).toBe('payment');
    expect(
      manager.findOne.mock.calls.slice(0, 2).map((call) => call[0]),
    ).toEqual([User, DriverPayout]);
  });
});
