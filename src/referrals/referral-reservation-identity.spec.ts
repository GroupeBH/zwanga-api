import { ReferralsService } from './referrals.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import { ReferralWithdrawal } from './entities/referral-withdrawal.entity';

describe('referral reservation rechecks current identity inside the transaction', () => {
  const input = { userId: 'user', tokens: 1000, amount: 10000, currency: 'CDF', moneyPerToken: 10, phone: 'synthetic' };
  function fixture(status: KycStatus | null, active = true) {
    const kyc = { findOne: jest.fn().mockResolvedValue(status ? { status } : null) };
    const manager = {
      findOne: jest.fn(async entity => entity === ReferralWithdrawal ? null : ({ id: input.userId, isActive: active, status: UserStatus.ACTIVE })),
      getRepository: jest.fn().mockReturnValue(kyc),
      create: jest.fn((_entity, data) => ({ id: 'withdrawal', ...data })),
      save: jest.fn(async value => value),
    };
    const account = { availableTokens: 1200, reservedTokens: 0 };
    const service = Object.assign(Object.create(ReferralsService.prototype), {
      dataSource: { transaction: jest.fn(async work => work(manager)) },
      getOrCreateAccount: jest.fn().mockResolvedValue(account),
      createLedgerEntry: jest.fn().mockResolvedValue(undefined),
    });
    return { service, manager, account, kyc };
  }

  it.each([null, KycStatus.PENDING, KycStatus.REJECTED])('does not reserve funds if current KYC is %s', async status => {
    const f = fixture(status);
    await expect(f.service.reserveWithdrawal(input)).rejects.toThrow('identité doit être vérifiée');
    expect(f.manager.findOne).toHaveBeenCalledWith(User, {
      where: { id: input.userId }, lock: { mode: 'pessimistic_write' },
    });
    expect(f.manager.getRepository).toHaveBeenCalledWith(KycDocument);
    expect(f.service.getOrCreateAccount).not.toHaveBeenCalled();
    expect(f.manager.save).not.toHaveBeenCalled();
  });

  it('refuses a deactivated account even if the outer check passed earlier', async () => {
    const f = fixture(KycStatus.APPROVED, false);
    await expect(f.service.reserveWithdrawal(input)).rejects.toThrow('Ce compte');
    expect(f.manager.save).not.toHaveBeenCalled();
  });

  it('preserves the existing reservation and ledger when current KYC is approved', async () => {
    const f = fixture(KycStatus.APPROVED);
    await expect(f.service.reserveWithdrawal(input)).resolves.toMatchObject({ created: true, withdrawal: { id: 'withdrawal', tokens: 1000 } });
    expect(f.account).toEqual({ availableTokens: 200, reservedTokens: 1000 });
    expect(f.service.createLedgerEntry).toHaveBeenCalledTimes(2);
    expect(f.kyc.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: input.userId }, order: { createdAt: 'DESC', id: 'DESC' },
    }));
  });
});
