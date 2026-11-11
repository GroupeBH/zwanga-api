import { accountPhoneWhere, authAccountPhoneWhere, canonicalAccountPhone } from './phone-identity';

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
  it('keeps the ownership lookup independent of account eligibility', () => {
    const condition = accountPhoneWhere('0891234567');
    expect(condition.objectLiteralParameters).toEqual({
      accountPhone: '+243891234567',
    });
    expect(condition.getSql!('u.phone')).toContain('LIMIT 2');
    expect(condition.getSql!('u.phone')).not.toContain('+243891234567');
    expect(condition.getSql!('u.phone')).not.toContain('isActive');
    expect(
      accountPhoneWhere('0891234567', false).getSql!('u.phone'),
    ).not.toContain('LIMIT 2');
  });

  it('selects only the single non-deactivated phone for authentication', () => {
    const condition = authAccountPhoneWhere('0891234567');
    const sql = condition.getSql!('u.phone');
    expect(condition.objectLiteralParameters).toEqual({ accountPhone: '+243891234567' });
    expect(sql).toContain('u.phone = (');
    expect(sql).toContain('CASE WHEN count(*) = 1 THEN min(phone_matches.phone) END');
    expect(sql).toContain('phone_owner."isActive" = true');
    expect(sql).toContain("phone_owner.status <> 'inactive'");
    expect(sql).toContain('LIMIT 2');
    expect(sql).not.toContain('+243891234567');
    expect(sql).not.toContain('suspended');
  });
});
