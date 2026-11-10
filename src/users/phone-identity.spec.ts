import { accountPhoneWhere, canonicalAccountPhone } from './phone-identity';

describe('account phone identity', () => {
  it.each([
    '0891234567',
    '891234567',
    '243891234567',
    '+243891234567',
    '00243891234567',
    ' 089 123-45-67 ',
  ])('canonicalizes %s', (phone) => {
    expect(canonicalAccountPhone(phone)).toBe('+243891234567');
  });
  it.each(['+3220000000', '+352260000', '+2250100000000', '+390600000000'])(
    'preserves the explicit international identity %s',
    (phone) => {
      expect(canonicalAccountPhone(phone)).toBe(phone);
    },
  );
  it.each(['', 'abc', '+', '++243891234567'])(
    'rejects %s before querying',
    (phone) => {
      expect(() => accountPhoneWhere(phone)).toThrow();
    },
  );
  it('uses bound parameters and a bounded ambiguity check on login/reset', () => {
    const condition = accountPhoneWhere('0891234567');
    expect(condition.objectLiteralParameters).toEqual({
      accountPhone: '+243891234567',
    });
    expect(condition.getSql!('u.phone')).toContain('LIMIT 2');
    expect(condition.getSql!('u.phone')).not.toContain('+243891234567');
    expect(
      accountPhoneWhere('0891234567', false).getSql!('u.phone'),
    ).not.toContain('LIMIT 2');
  });
});
