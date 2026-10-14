import { ReferralsService } from './referrals.service';
import {
  PaymentPurpose,
  PaymentStatus,
} from '../payments/entities/payment-transaction.entity';

function fixture() {
  const service = Object.create(ReferralsService.prototype);
  const withdrawal = {
    id: 'withdrawal',
    userId: 'user',
    tokens: 1000,
    amount: 25000,
    currency: 'CDF',
    moneyPerToken: 25,
  };
  const payments = {
    initiatePayout: jest
      .fn()
      .mockResolvedValue({ id: 'payment', status: PaymentStatus.INITIATED }),
    findLatestTransactionForRelatedEntity: jest.fn().mockResolvedValue(null),
  };
  Object.assign(service, {
    configService: {
      get: (key: string) =>
        ({
          REFERRAL_MIN_WITHDRAWAL_TOKENS: 50,
          REFERRAL_MONEY_PER_TOKEN_CDF: 100,
        })[key],
    },
    WITHDRAWAL_RELATED_ENTITY_TYPE: 'referral_withdrawal',
    releaseMatureRewardsForUser: jest.fn(),
    kycRepository: { exists: jest.fn().mockResolvedValue(true) },
    userRepository: {
      findOne: jest
        .fn()
        .mockResolvedValue({
          id: 'user',
          phone: '+243891234567',
          isActive: true,
          status: 'active',
        }),
    },
    reserveWithdrawal: jest.fn().mockResolvedValue(withdrawal),
    getWithdrawalCallbackUrl: () => 'https://example.invalid/callback',
    paymentsService: payments,
    failWithdrawal: jest.fn(),
    applyPaymentToWithdrawal: jest.fn().mockResolvedValue(withdrawal),
  });
  return { service, withdrawal, payments };
}

describe('referral withdrawal threshold and CDF denomination', () => {
  it.each([0, 50, 999, 999.99, 999.999, NaN, Infinity])(
    'refuses %s tokens without any side effect',
    async (tokens) => {
      const { service, payments } = fixture();
      await expect(
        service.requestWithdrawal('user', { tokens }),
      ).rejects.toThrow('1000');
      expect(service.releaseMatureRewardsForUser).not.toHaveBeenCalled();
      expect(service.reserveWithdrawal).not.toHaveBeenCalled();
      expect(payments.initiatePayout).not.toHaveBeenCalled();
    },
  );

  it.each([
    [1000, 25000],
    [1000.01, 25000.25],
    [1200, 30000],
  ])(
    'allows %s referral tokens at %s CDF despite legacy env values',
    async (tokens, amount) => {
      const { service, payments, withdrawal } = fixture();
      expect(await service.requestWithdrawal('user', { tokens })).toBe(
        withdrawal,
      );
      expect(service.reserveWithdrawal).toHaveBeenCalledWith(
        expect.objectContaining({
          tokens,
          amount,
          currency: 'CDF',
          moneyPerToken: 25,
        }),
      );
      expect(payments.initiatePayout).toHaveBeenCalledWith(
        expect.objectContaining({
          purpose: PaymentPurpose.REFERRAL_PAYOUT,
          relatedEntityType: 'referral_withdrawal',
          amount,
          currency: 'CDF',
        }),
      );
    },
  );

  it('still requires approved KYC', async () => {
    const { service, payments } = fixture();
    service.kycRepository.exists.mockResolvedValue(false);
    await expect(
      service.requestWithdrawal('user', { tokens: 1000 }),
    ).rejects.toThrow('vérifiée');
    expect(service.reserveWithdrawal).not.toHaveBeenCalled();
    expect(payments.initiatePayout).not.toHaveBeenCalled();
  });

  it('does not send a payout when the locked referral balance is insufficient', async () => {
    const { service, payments } = fixture();
    service.reserveWithdrawal.mockRejectedValue(new Error('Solde insuffisant'));
    await expect(
      service.requestWithdrawal('user', { tokens: 1000 }),
    ).rejects.toThrow('insuffisant');
    expect(payments.initiatePayout).not.toHaveBeenCalled();
  });

  it('keeps the reservation when a local error follows an uncertain provider submission', async () => {
    const { service, payments } = fixture();
    const pending = { id: 'payment', status: PaymentStatus.PENDING };
    payments.initiatePayout.mockRejectedValue(new Error('Lost response'));
    payments.findLatestTransactionForRelatedEntity.mockResolvedValue(pending);
    await service.requestWithdrawal('user', { tokens: 1000 });
    expect(service.applyPaymentToWithdrawal).toHaveBeenCalledWith(
      pending,
      'user',
    );
    expect(service.failWithdrawal).not.toHaveBeenCalled();
  });

  it('does not refund a reservation on an unproven technical failure', async () => {
    const { service, payments } = fixture();
    payments.initiatePayout.mockRejectedValue(new Error('Offline'));
    await expect(
      service.requestWithdrawal('user', { tokens: 1000 }),
    ).rejects.toThrow('Offline');
    expect(service.failWithdrawal).not.toHaveBeenCalled();
  });
});
