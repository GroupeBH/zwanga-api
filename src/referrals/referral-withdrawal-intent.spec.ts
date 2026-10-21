import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RequestReferralWithdrawalDto } from './dto/referral.dto';
import { assertSameReferralIntent, referralWithdrawalKey, referralWithdrawalPhone } from './referral-withdrawal-intent';

describe('referral withdrawal intent contract', () => {
  it('keeps the legacy DTO valid and accepts an optional UUID intent', async () => {
    expect(await validate(plainToInstance(RequestReferralWithdrawalDto, { tokens: 1000 }))).toHaveLength(0);
    expect(await validate(plainToInstance(RequestReferralWithdrawalDto, { tokens: 1000, idempotencyKey: '550e8400-e29b-41d4-a716-446655440000' }))).toHaveLength(0);
    expect(await validate(plainToInstance(RequestReferralWithdrawalDto, { tokens: 1000, idempotencyKey: 'wrong' }))).not.toHaveLength(0);
  });
  it('normalizes keys and accepts the same RDC phone with/without plus', () => {
    expect(referralWithdrawalKey('550E8400-E29B-41D4-A716-446655440000')).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(referralWithdrawalKey()).toBeNull();
    expect(referralWithdrawalPhone(' +243891234567 ')).toBe('243891234567');
    expect(() => assertSameReferralIntent({ tokens: '1000.00', phone: '+243891234567' } as any, 1000, '243891234567')).not.toThrow();
  });
  it.each(['', 'synthetic', '24389123456', '2438912345678', '24389 1234567'])('rejects invalid destination %s before reservation', phone => {
    expect(() => referralWithdrawalPhone(phone)).toThrow();
  });
  it('rejects a changed destination or amount without revealing another intent', () => {
    const existing = { id: 'own-id', tokens: 1000, phone: '243891234567' } as any;
    expect(() => assertSameReferralIntent(existing, 1001, existing.phone)).toThrow();
    expect(() => assertSameReferralIntent(existing, 1000, '243891234568')).toThrow();
  });
});
