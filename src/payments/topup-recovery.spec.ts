import { PaymentsService } from './payments.service';
import { claimTopUpPayment, topUpReference } from './topup-payment-claim';
import { recoverTopUpClaim } from './topup-recovery';
import { PaymentMethod, PaymentPurpose, PaymentStatus, PaymentTransaction } from './entities/payment-transaction.entity';

describe('topup recovery (repository simulation; no provider HTTP)', () => {
  const candidate = () => ({ userId: 'user', purpose: PaymentPurpose.WALLET_TOP_UP, relatedEntityType: 'wallet_account',
    reference: topUpReference('user', 'key'), amount: 3920, tokenQuantity: 392, currency: 'CDF',
    method: PaymentMethod.MOBILE_MONEY, phone: 'synthetic-phone', status: PaymentStatus.PENDING } as PaymentTransaction);
  function fixture() {
    let row: PaymentTransaction | undefined;
    const repo = { create: (value: PaymentTransaction) => value, findOne: jest.fn(async () => row),
      save: jest.fn(async (value: PaymentTransaction) => {
        if (row) throw { code: '23505' };
        row = value; return value;
      }) };
    return { repo, get row() { return row; }, set row(value) { row = value; } };
  }
  it('seals an unsent key; a late initiation reuses cancellation and must not debit', async () => {
    const f = fixture();
    expect((await recoverTopUpClaim(f.repo as any, candidate())).status).toBe(PaymentStatus.CANCELLED);
    const late = await claimTopUpPayment(f.repo as any, candidate());
    expect(late.created).toBe(false); expect(late.payment.status).toBe(PaymentStatus.CANCELLED);
  });
  it('does not cancel an initiation which won the unique reference race', async () => {
    const f = fixture();
    const [initiation, recovery] = await Promise.all([
      claimTopUpPayment(f.repo as any, candidate()), recoverTopUpClaim(f.repo as any, candidate()),
    ]);
    expect(initiation.created).toBe(true); expect(recovery.status).toBe(PaymentStatus.PENDING);
  });
  it.each([PaymentStatus.PENDING, PaymentStatus.INITIATED, PaymentStatus.SUCCEEDED, PaymentStatus.FAILED])('preserves an existing %s outcome', async status => {
    const f = fixture(); f.row = { ...candidate(), status, amount: 3500 };
    expect(await recoverTopUpClaim(f.repo as any, candidate())).toBe(f.row);
    expect(f.repo.save).not.toHaveBeenCalled(); // token purchase quote survives a tariff change
  });
  it.each([{ userId: 'other' }, { tokenQuantity: 20 }, { purpose: 'trip_booking' }, { phone: 'other' }])('rejects a mismatched intent %j', async patch => {
    const f = fixture(); f.row = { ...candidate(), ...patch };
    await expect(recoverTopUpClaim(f.repo as any, candidate())).rejects.toMatchObject({ status: 409 });
    expect(f.repo.save).not.toHaveBeenCalled();
  });
  it('returns terminal outcomes without needing the provider and rechecks pending references', async () => {
    const f = fixture(), service = new PaymentsService(f.repo as any, {} as any, {} as any, {} as any, {} as any);
    const check = jest.spyOn(service, 'checkPaymentStatus').mockResolvedValue({ ...candidate(), status: PaymentStatus.FAILED });
    const input = { userId: 'user', idempotencyKey: 'key', tokenQuantity: 392, amount: 3920, currency: 'CDF',
      method: PaymentMethod.MOBILE_MONEY, phone: 'synthetic-phone', description: 'Synthetic', relatedEntityType: 'wallet_account' };
    f.row = { ...candidate(), status: PaymentStatus.FAILED };
    expect((await service.recoverWalletTopUp(input)).status).toBe(PaymentStatus.FAILED);
    expect(check).not.toHaveBeenCalled();
    f.row = { ...candidate(), orderNumber: 'order' };
    expect((await service.recoverWalletTopUp(input)).status).toBe(PaymentStatus.FAILED);
    expect(check).toHaveBeenCalledWith('order', 'user');
  });
  it('does not invent a refusal for an uncertain delivery without a provider reference', async () => {
    const f = fixture(), service = new PaymentsService(f.repo as any, {} as any, {} as any, {} as any, {} as any);
    f.row = { ...candidate(), orderNumber: null };
    expect((await service.recoverWalletTopUp({ userId: 'user', idempotencyKey: 'key', tokenQuantity: 392, amount: 3920,
      currency: 'CDF', method: PaymentMethod.MOBILE_MONEY, phone: 'synthetic-phone', description: 'Synthetic' })).status).toBe(PaymentStatus.PENDING);
  });
});
