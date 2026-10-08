import { BadRequestException } from '@nestjs/common';
import { normalizeOtpPhone } from './otp-phone.util';

describe('international OTP phone normalization (no real delivery)', () => {
  it.each([
    ['+32 2 000 00 00', '3220000000'],
    ['0032 2 000 00 00', '3220000000'],
    ['+352 26 00 00', '352260000'],
    ['00352 26 00 00', '352260000'],
    ['+47 4000 0000', '4740000000'],
    ['+354 600 0000', '3546000000'],
    ['+683 4000', '6834000'],
    ['+33 (6) 00-00-00-00', '33600000000'],
    ['+1 (202) 555-0100', '12025550100'],
    ['+225 01 00 00 00 00', '2250100000000'],
    ['+39 06 0000 0000', '390600000000'],
    ['+123456789012345', '123456789012345'],
  ])('preserves the explicit country code in %s', (input, expected) => {
    expect(normalizeOtpPhone(input)).toBe(expected);
    // The default country never overrides an explicit international prefix.
    expect(normalizeOtpPhone(input, '+254')).toBe(expected);
  });

  it.each([
    '0900000000',
    '900000000',
    '243900000000',
    '+243900000000',
    '00243900000000',
    ' 09 00 00 00 00 ',
  ])('preserves the existing RDC destination for %s', (input) => {
    expect(normalizeOtpPhone(input)).toBe('243900000000');
  });

  it.each([
    '',
    ' ',
    '+',
    '00',
    '++3220000000',
    '+003220000000',
    '+03220000000',
    '0003220000000',
    '+32foo20000000',
    '+123456',
    '+1234567890123456',
    '+32 20000000 ext 1',
  ])('rejects malformed international numbers: %s', (input) => {
    expect(() => normalizeOtpPhone(input)).toThrow(BadRequestException);
  });

  it('does not collide short foreign numbers with inferred RDC numbers', () => {
    expect(normalizeOtpPhone('+352260000')).not.toBe(
      normalizeOtpPhone('352260000'),
    );
    expect(normalizeOtpPhone('0700000000', '+254')).toBe('254700000000');
  });
});
