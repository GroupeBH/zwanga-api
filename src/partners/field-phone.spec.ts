import { canonicalFieldPhone, fieldPhoneVariants } from './field-phone';

describe('field lead phone matching', () => {
  it.each(['0812345678', '+243812345678', '243812345678', '00243812345678', '812345678'])('normalizes %s', (value) => {
    expect(canonicalFieldPhone(value)).toBe('+243812345678');
  });
  it('matches every accepted Zwanga account spelling', () => {
    expect(fieldPhoneVariants('+243812345678')).toEqual(expect.arrayContaining(['0812345678', '+243812345678', '00243812345678']));
  });
});
