import {
  walletMovementNotification,
  referralMovementNotification,
  paymentNotification,
  withdrawalNotification,
} from './financial-notification.policy';
import {
  WalletLedgerEntry,
  WalletLedgerEntryType,
} from '../wallet/entities/wallet-ledger-entry.entity';
import {
  ReferralLedgerEntry,
  ReferralLedgerEntryType,
  ReferralBalanceBucket,
} from '../referrals/entities/referral-ledger-entry.entity';
import {
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { UserRole } from '../users/entities/user.entity';

describe('financial notification coverage', () => {
  it('presents the driver welcome bonus in FC for Pro without changing the mobile payload', () => {
    const result = walletMovementNotification({
      id: 'welcome', userId: 'driver',
      type: WalletLedgerEntryType.LOYALTY_REWARD,
      relatedEntityType: 'welcome_bonus', amount: 50,
      balanceAfter: 150, currency: 'PTS',
    } as WalletLedgerEntry, UserRole.DRIVER)!;
    expect(result.body).toBe(
      'Bienvenue chez Zwanga ! 5 000 FC vous sont offerts sous forme de jetons Zwanga pour vous permettre de payer votre abonnement Pro.',
    );
    expect(result.body).not.toMatch(/50 jetons|abonnement activé/);
    expect(result.data).toMatchObject({ amount: 50, currency: 'PTS', balanceAfter: 150,
      type: 'wallet_loyalty_reward', relatedEntityType: 'welcome_bonus' });
  });

  it.each([UserRole.PASSENGER, undefined])('keeps non-driver welcome copy unchanged (%s)', role => {
    const result = walletMovementNotification({
      id: 'welcome', userId: 'passenger', type: WalletLedgerEntryType.LOYALTY_REWARD,
      relatedEntityType: 'welcome_bonus', amount: 50, currency: 'PTS', balanceAfter: 50,
    } as WalletLedgerEntry, role)!;
    expect(result.body).toContain('50 jetons de bienvenue');
    expect(result.body).not.toContain('abonnement Pro');
  });

  it('does not advertise the fixed FC welcome offer for a different credit', () => {
    const result = walletMovementNotification({
      id: 'welcome', userId: 'driver', type: WalletLedgerEntryType.LOYALTY_REWARD,
      relatedEntityType: 'welcome_bonus', amount: 25, currency: 'PTS', balanceAfter: 25,
    } as WalletLedgerEntry, UserRole.DRIVER)!;
    expect(result.body).toContain('25 jetons');
    expect(result.body).not.toContain('5 000 FC');
  });

  it('identifies the welcome bonus without breaking the existing mobile event type', () => {
    const result = walletMovementNotification({
      id: 'welcome',
      userId: 'owner',
      type: WalletLedgerEntryType.LOYALTY_REWARD,
      relatedEntityType: 'welcome_bonus',
      relatedEntityId: 'owner',
      amount: 50,
      withdrawableAmount: 0,
      balanceAfter: 150,
      currency: 'PTS',
      paymentTransactionId: null,
    } as WalletLedgerEntry)!;
    expect(result).toMatchObject({
      eventKey: 'wallet:welcome',
      title: 'Bonus de bienvenue reçu',
      data: {
        type: 'wallet_loyalty_reward',
        relatedEntityType: 'welcome_bonus',
        amount: 50,
      },
    });
    expect(result.body).toBe(
      'Votre identité et votre compte sont validés. 50 jetons de bienvenue ont été ajoutés à votre portefeuille.',
    );
  });

  it.each(Object.values(WalletLedgerEntryType))(
    'covers wallet movement %s or delegates to withdrawal lifecycle',
    (type) => {
      const notification = walletMovementNotification({
        id: 'entry',
        userId: 'owner',
        type,
        amount: 25,
        balanceAfter: 125,
        currency: 'PTS',
      } as WalletLedgerEntry);
      if (
        [
          WalletLedgerEntryType.WITHDRAWAL,
          WalletLedgerEntryType.WITHDRAWAL_REFUND,
        ].includes(type)
      ) {
        expect(notification).toBeNull();
      } else {
        expect(notification).toMatchObject({
          eventKey: 'wallet:entry',
          userId: 'owner',
          data: {
            type: `wallet_${type}`,
            amount: 25,
            balanceAfter: 125,
            currency: 'PTS',
          },
        });
        expect(notification!.body).toContain('125 jetons');
      }
    },
  );

  it.each([25, -25])(
    'uses the correct credit/debit copy for an admin adjustment of %s',
    (amount) => {
      const notification = walletMovementNotification({
        id: 'entry',
        userId: 'owner',
        type: WalletLedgerEntryType.ADMIN_ADJUSTMENT,
        amount,
        balanceAfter: 100 + amount,
        currency: 'PTS',
        description: 'Internal admin identity and sensitive support notes',
      } as WalletLedgerEntry)!;
      expect(notification.body).toContain(
        amount > 0 ? 'ajouté 25 jetons' : 'retiré 25 jetons',
      );
      expect(JSON.stringify(notification)).not.toContain('sensitive');
      expect(notification.data.amount).toBe(amount);
    },
  );

  it('notifies the sender and the recipient with different stable ledger keys', () => {
    const sender = walletMovementNotification({
      id: 'debit',
      userId: 'sender',
      type: WalletLedgerEntryType.TRANSFER_OUT,
      relatedEntityType: 'wallet_transfer',
      relatedEntityId: 'transfer',
      amount: -5,
      balanceAfter: 5,
      currency: 'PTS',
    } as WalletLedgerEntry)!;
    const recipient = walletMovementNotification({
      id: 'credit',
      userId: 'recipient',
      type: WalletLedgerEntryType.TRANSFER_IN,
      relatedEntityType: 'wallet_transfer',
      relatedEntityId: 'transfer',
      amount: 5,
      balanceAfter: 10,
      currency: 'PTS',
    } as WalletLedgerEntry)!;
    expect(sender.userId).toBe('sender');
    expect(recipient.userId).toBe('recipient');
    expect(sender.eventKey).not.toBe(recipient.eventKey);
    expect(sender.data).toMatchObject({ transferId: 'transfer', amount: -5 });
    expect(recipient.data).toMatchObject({ transferId: 'transfer', amount: 5 });
  });

  it('notifies a released referral commission once across its two bucket entries', () => {
    const entry = {
      id: 'entry',
      userId: 'referrer',
      type: ReferralLedgerEntryType.REWARD_RELEASED,
      amountTokens: 5,
      balanceAfter: 10,
    } as ReferralLedgerEntry;
    expect(
      referralMovementNotification({
        ...entry,
        bucket: ReferralBalanceBucket.PENDING,
        amountTokens: -5,
      }),
    ).toBeNull();
    expect(
      referralMovementNotification({
        ...entry,
        bucket: ReferralBalanceBucket.AVAILABLE,
      }),
    ).toMatchObject({
      userId: 'referrer',
      data: { type: 'referral_reward_released' },
    });
  });

  it.each([
    ReferralLedgerEntryType.ATTRIBUTION_BONUS,
    ReferralLedgerEntryType.REWARD_PENDING,
    ReferralLedgerEntryType.REWARD_REVERSED,
  ])('notifies referral %s', (type) => {
    expect(
      referralMovementNotification({
        id: 'entry',
        userId: 'referrer',
        type,
        amountTokens: 5,
        bucket: ReferralBalanceBucket.PENDING,
      } as ReferralLedgerEntry),
    ).toMatchObject({ userId: 'referrer', data: { type: `referral_${type}` } });
  });

  it.each([
    PaymentPurpose.DRIVER_PAYOUT,
    PaymentPurpose.WALLET_PAYOUT,
    PaymentPurpose.REFERRAL_PAYOUT,
    PaymentPurpose.WALLET_TOP_UP,
  ])('does not duplicate successful %s business notifications', (purpose) => {
    expect(
      paymentNotification({
        userId: 'user',
        purpose,
        status: PaymentStatus.SUCCEEDED,
      } as PaymentTransaction),
    ).toBeNull();
  });

  it.each([PaymentStatus.PENDING, PaymentStatus.INITIATED])(
    'never announces payment success for %s',
    (status) => {
      expect(
        paymentNotification({
          userId: 'user',
          purpose: PaymentPurpose.TRIP_BOOKING,
          status,
        } as PaymentTransaction),
      ).toBeNull();
    },
  );

  it.each([
    PaymentStatus.SUCCEEDED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ])('notifies a definitive payment result %s', (status) => {
    expect(
      paymentNotification({
        id: 'payment',
        userId: 'user',
        purpose: PaymentPurpose.SUBSCRIPTION_PRO,
        amount: 500,
        currency: 'CDF',
        status,
      } as PaymentTransaction),
    ).toMatchObject({
      eventKey: `payment:payment:${status}`,
      userId: 'user',
      data: { status, amount: 500 },
    });
  });

  it.each(['driver', 'wallet', 'referral'] as const)(
    'covers every %s withdrawal state and coalesces acknowledgement with reservation',
    (kind) => {
      const input = {
        id: 'withdrawal',
        userId: 'user',
        kind,
        amount: 100,
        currency: 'CDF',
      };
      for (const status of [
        'pending',
        'succeeded',
        'failed',
        'cancelled',
        'review',
      ]) {
        expect(withdrawalNotification({ ...input, status })).toMatchObject({
          eventKey: `${kind}-withdrawal:withdrawal:${status}`,
          data: { status },
        });
      }
      expect(
        withdrawalNotification({ ...input, status: 'pending' })?.eventKey,
      ).toBe(
        withdrawalNotification({ ...input, status: 'initiated' })?.eventKey,
      );
      expect(
        withdrawalNotification({ ...input, status: 'succeeded', review: true })
          ?.title,
      ).toBe('Retrait en vérification');
    },
  );
});
