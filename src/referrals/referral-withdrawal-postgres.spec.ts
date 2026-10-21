import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { User, UserStatus } from '../users/entities/user.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import { WalletAccount, WalletAccountType } from '../wallet/entities/wallet-account.entity';
import { PaymentStatus } from '../payments/entities/payment-transaction.entity';
import { ReferralsService } from './referrals.service';
import { ReferralAccount } from './entities/referral-account.entity';
import { ReferralLedgerEntry, ReferralLedgerEntryType } from './entities/referral-ledger-entry.entity';
import { ReferralWithdrawal, ReferralWithdrawalStatus } from './entities/referral-withdrawal.entity';
import { ReferralReward, ReferralRewardSourceType, ReferralRewardStatus } from './entities/referral-reward.entity';

// Fresh disposable loopback cluster only. No .env, application DB or real payout.
const bin = process.env.REFERRAL_TEST_POSTGRES_BIN ?? process.env.PAYOUT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('available-only referral withdrawals on PostgreSQL', () => {
  jest.setTimeout(90000);
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource;
  let service: ReferralsService;
  let payments: { initiatePayout: jest.Mock };

  beforeAll(async () => {
    db = await cluster.start();
    db.setOptions({ entities: typeOrmEntities });
    await (db as any).buildMetadatas();
    await db.query('CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await db.synchronize();
  });
  afterAll(() => cluster.stop());
  beforeEach(async () => {
    await db.query('TRUNCATE users CASCADE');
    payments = {
      initiatePayout: jest.fn(async input => ({
        ...input, id: randomUUID(), status: PaymentStatus.INITIATED,
      })),
    };
    service = Object.assign(Object.create(ReferralsService.prototype), {
      dataSource: db,
      rewardReconciliations: new Map(),
      kycRepository: db.getRepository(KycDocument),
      userRepository: db.getRepository(User),
      withdrawalRepository: db.getRepository(ReferralWithdrawal),
      paymentsService: payments,
      configService: { get: () => undefined },
      DEFAULT_HOLD_DAYS: 7,
      WITHDRAWAL_RELATED_ENTITY_TYPE: 'referral_withdrawal',
      getWithdrawalCallbackUrl: () => 'https://example.invalid/callback',
      // Isolate provider settlement, not the real reservation/reconciliation logic.
      applyPaymentToWithdrawal: (payment: { relatedEntityId: string }) =>
        db.getRepository(ReferralWithdrawal).findOneByOrFail({ id: payment.relatedEntityId }),
    });
  });

  async function fixture(availableTokens: number, pendingTokens = 5000, reservedTokens = 3000) {
    const user = await db.getRepository(User).save({
      firstName: 'Synthetic', lastName: 'Referral', phone: '+243891234567',
      isActive: true, status: UserStatus.ACTIVE,
    });
    await db.getRepository(KycDocument).save({ userId: user.id, status: KycStatus.APPROVED });
    const account = await db.getRepository(ReferralAccount).save({
      userId: user.id, availableTokens, pendingTokens, reservedTokens,
      withdrawnTokens: 2000, currency: 'PTS',
    });
    await db.getRepository(WalletAccount).save({
      userId: user.id, type: WalletAccountType.POINTS, balance: 100000,
      withdrawableBalance: 100000, currency: 'PTS',
    });
    return { user, account };
  }
  const balance = (userId: string) =>
    db.getRepository(ReferralAccount).findOneByOrFail({ userId });

  it('cannot supplement an insufficient available balance from pending, reserved or wallet tokens', async () => {
    const { user, account } = await fixture(800);
    await expect(service.requestWithdrawal(user.id, { tokens: 1000 }))
      .rejects.toThrow('disponibles insuffisant');
    expect(await balance(user.id)).toMatchObject({
      availableTokens: '800.00', pendingTokens: '5000.00',
      reservedTokens: '3000.00', withdrawnTokens: '2000.00',
    });
    expect(await db.getRepository(WalletAccount).findOneByOrFail({ userId: user.id }))
      .toMatchObject({ balance: '100000.00', withdrawableBalance: '100000.00' });
    expect(await db.getRepository(ReferralWithdrawal).count()).toBe(0);
    expect(await db.getRepository(ReferralLedgerEntry).countBy({ accountId: account.id })).toBe(0);
    expect(payments.initiatePayout).not.toHaveBeenCalled();
  });

  it('allows the exact available balance, including hundredths', async () => {
    const { user } = await fixture(1000.01);
    await service.requestWithdrawal(user.id, { tokens: 1000.01 });
    expect(await balance(user.id)).toMatchObject({
      availableTokens: '0.00', reservedTokens: '4000.01', pendingTokens: '5000.00',
    });
    expect(payments.initiatePayout).toHaveBeenCalledWith(expect.objectContaining({
      amount: 10000.1, currency: 'CDF', userId: user.id,
    }));
  });

  it('coalesces two legacy concurrent requests into one withdrawal', async () => {
    const { user, account } = await fixture(1500, 5000, 0);
    const results = await Promise.allSettled([
      service.requestWithdrawal(user.id, { tokens: 1000 }),
      service.requestWithdrawal(user.id, { tokens: 1000 }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    expect((results[0] as PromiseFulfilledResult<ReferralWithdrawal>).value.id)
      .toBe((results[1] as PromiseFulfilledResult<ReferralWithdrawal>).value.id);
    expect(await balance(user.id)).toMatchObject({
      availableTokens: '500.00', reservedTokens: '1000.00', pendingTokens: '5000.00',
    });
    expect(await db.getRepository(ReferralWithdrawal).count()).toBe(1);
    expect(await db.getRepository(ReferralLedgerEntry).countBy({
      accountId: account.id, type: ReferralLedgerEntryType.WITHDRAWAL_RESERVED,
    })).toBe(2);
    expect(payments.initiatePayout).toHaveBeenCalledTimes(1);
  });

  it('deduplicates the same keyed intent even when funds cover multiple sends', async () => {
    const { user } = await fixture(5000, 0, 0);
    const dto = { tokens: 1000, idempotencyKey: randomUUID() };
    const results = await Promise.all(Array.from({ length: 5 }, () => service.requestWithdrawal(user.id, dto)));
    expect(new Set(results.map(r => r.id)).size).toBe(1);
    expect(await balance(user.id)).toMatchObject({ availableTokens: '4000.00', reservedTokens: '1000.00' });
    expect(payments.initiatePayout).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed amount or destination for the same key, and a second active intent', async () => {
    const { user } = await fixture(5000, 0, 0);
    const dto = { tokens: 1000, idempotencyKey: randomUUID() };
    const first = await service.requestWithdrawal(user.id, dto);
    await expect(service.requestWithdrawal(user.id, { ...dto, tokens: 1001 })).rejects.toMatchObject({ status: 409 });
    await expect(service.requestWithdrawal(user.id, { ...dto, phone: '+243891234568' })).rejects.toMatchObject({ status: 409 });
    await expect(service.requestWithdrawal(user.id, { ...dto, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 409 });
    expect((await service.getWithdrawalById(user.id, first.id)).id).toBe(first.id);
    await expect(service.getWithdrawalById(randomUUID(), first.id)).rejects.toMatchObject({ status: 404 });
    expect(payments.initiatePayout).toHaveBeenCalledTimes(1);
  });

  it('replays a completed keyed withdrawal indefinitely without repricing it', async () => {
    const { user } = await fixture(5000, 0, 0);
    const idempotencyKey = randomUUID();
    const first = await service.requestWithdrawal(user.id, { tokens: 1000, idempotencyKey });
    await db.getRepository(ReferralWithdrawal).update(first.id, {
      status: ReferralWithdrawalStatus.SUCCEEDED, amount: 25000, moneyPerToken: 25,
      requestedAt: new Date(Date.now() - 86400000),
    });
    const replay = await service.requestWithdrawal(user.id, { tokens: 1000, idempotencyKey });
    expect(replay).toMatchObject({ id: first.id, amount: '25000.00', status: ReferralWithdrawalStatus.SUCCEEDED });
    expect(payments.initiatePayout).toHaveBeenCalledTimes(1);
  });

  it('does not resend after a lost provider response or a crash before submission', async () => {
    const { user } = await fixture(5000, 0, 0);
    const dto = { tokens: 1000, idempotencyKey: randomUUID() };
    Object.assign(payments, { findLatestTransactionForRelatedEntity: jest.fn().mockResolvedValue(null) });
    payments.initiatePayout.mockRejectedValueOnce(new Error('Synthetic lost response'));
    await expect(service.requestWithdrawal(user.id, dto)).rejects.toThrow('lost response');
    const replay = await service.requestWithdrawal(user.id, dto);
    expect(replay.status).toBe(ReferralWithdrawalStatus.PENDING);
    expect(payments.initiatePayout).toHaveBeenCalledTimes(1);
    expect(await balance(user.id)).toMatchObject({ availableTokens: '4000.00', reservedTokens: '1000.00' });
  });

  it('coalesces legacy retries immediately after terminal response but allows a new keyed intent', async () => {
    const { user } = await fixture(5000, 0, 0);
    const first = await service.requestWithdrawal(user.id, { tokens: 1000 });
    await db.getRepository(ReferralWithdrawal).update(first.id, { status: ReferralWithdrawalStatus.SUCCEEDED,
      requestedAt: new Date(Date.now() - 86400000), processedAt: new Date() });
    expect((await service.requestWithdrawal(user.id, { tokens: 1000 })).id).toBe(first.id);
    expect((await service.requestWithdrawal(user.id, { tokens: 1000, idempotencyKey: randomUUID() })).id).not.toBe(first.id);
    expect(payments.initiatePayout).toHaveBeenCalledTimes(2);
  });

  it('does not release immature commissions, but allows them after their hold expires', async () => {
    const { user } = await fixture(800, 200, 0);
    const referred = await db.getRepository(User).save({ firstName: 'Synthetic', lastName: 'Referred' });
    const reward = await db.getRepository(ReferralReward).save({
      referrerUserId: user.id, referredUserId: referred.id,
      sourceType: ReferralRewardSourceType.BOOKING_PAYMENT, sourceEntityId: randomUUID(),
      grossAmount: 500000, sourceCurrency: 'CDF', rate: 0.01,
      rewardAmount: 5000, rewardTokens: 200, sourceMoneyPerToken: 25,
      status: ReferralRewardStatus.PENDING, holdUntil: new Date(Date.now() + 86400000),
    });
    await expect(service.requestWithdrawal(user.id, { tokens: 1000 }))
      .rejects.toThrow('disponibles insuffisant');
    expect(await balance(user.id)).toMatchObject({ availableTokens: '800.00', pendingTokens: '200.00' });
    expect(payments.initiatePayout).not.toHaveBeenCalled();

    await db.getRepository(ReferralReward).update(reward.id, { holdUntil: new Date(Date.now() - 60000) });
    await service.requestWithdrawal(user.id, { tokens: 1000 });
    expect(await balance(user.id)).toMatchObject({
      availableTokens: '0.00', pendingTokens: '0.00', reservedTokens: '1000.00',
    });
    expect(payments.initiatePayout).toHaveBeenCalledTimes(1);
  });

  it('rolls back the reservation completely if its ledger cannot be written', async () => {
    const { user } = await fixture(1500, 0, 0);
    const ledger = jest.spyOn(service as any, 'createLedgerEntry')
      .mockRejectedValueOnce(new Error('Synthetic ledger failure'));
    try {
      await expect(service.requestWithdrawal(user.id, { tokens: 1000 }))
        .rejects.toThrow('Synthetic ledger failure');
      expect(await balance(user.id)).toMatchObject({
        availableTokens: '1500.00', reservedTokens: '0.00',
      });
      expect(await db.getRepository(ReferralWithdrawal).count()).toBe(0);
      expect(payments.initiatePayout).not.toHaveBeenCalled();
    } finally {
      ledger.mockRestore();
    }
  });
});
