import { claimTopUpPayment, topUpReference } from './topup-payment-claim';
import { PaymentMethod, PaymentPurpose, PaymentStatus, PaymentTransaction } from './entities/payment-transaction.entity';

describe('topup idempotency using the existing unique reference index', () => {
  const candidate = () => ({ reference: topUpReference('user', 'key'), userId: 'user',
    purpose: PaymentPurpose.WALLET_TOP_UP, method: PaymentMethod.MOBILE_MONEY,
    amount: 100, currency: 'CDF', phone: 'synthetic-phone', status: PaymentStatus.PENDING } as PaymentTransaction);
  it('scopes stable references by account and fits provider reference limits', () => {
    expect(topUpReference('user', 'key')).toBe(topUpReference('user', 'key'));
    expect(topUpReference('user', 'key')).not.toBe(topUpReference('other', 'key'));
    expect(topUpReference('user', 'key')).toMatch(/^[A-Z0-9]{25}$/);
  });
  it('allows only one concurrent caller to initiate provider delivery', async () => {
    let stored: PaymentTransaction | undefined;
    const repository = { save: jest.fn(async (row: PaymentTransaction) => {
      if (stored) throw { driverError: { code: '23505' } };
      stored = row; return row;
    }), findOne: jest.fn(async () => stored) };
    const claims = await Promise.all([claimTopUpPayment(repository as any, candidate()), claimTopUpPayment(repository as any, candidate())]);
    expect(claims.filter(result => result.created)).toHaveLength(1);
    expect(claims[0].payment).toBe(claims[1].payment);
  });
  it.each([PaymentStatus.PENDING, PaymentStatus.SUCCEEDED, PaymentStatus.FAILED])('does not resubmit an existing %s payment', async status => {
    const existing = { ...candidate(), status, amount: '100.00' };
    const repository = { save: jest.fn().mockRejectedValue({ code: '23505' }), findOne: jest.fn().mockResolvedValue(existing) };
    expect(await claimTopUpPayment(repository as any, candidate())).toEqual({ payment: existing, created: false });
  });
  it.each([{ amount: 200 }, { phone: 'other' }, { userId: 'other' }, { method: PaymentMethod.CARD }])('rejects altered financial payloads %j', async change => {
    const repository = { save: jest.fn().mockRejectedValue({ code: '23505' }), findOne: jest.fn().mockResolvedValue({ ...candidate(), ...change }) };
    await expect(claimTopUpPayment(repository as any, candidate())).rejects.toMatchObject({ status: 409 });
  });
  it('does not swallow unrelated database errors', async () => {
    const repository = { save: jest.fn().mockRejectedValue(new Error('offline')), findOne: jest.fn() };
    await expect(claimTopUpPayment(repository as any, candidate())).rejects.toThrow('offline');
    expect(repository.findOne).not.toHaveBeenCalled();
  });
});
