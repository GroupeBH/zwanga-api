import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosRequestConfig } from 'axios';
import { Observable, of } from 'rxjs';
import { KeccelOtpGenerateResponse } from './dto/keccel-otp.dto';
import { KeccelOtpService } from './keccel-otp.service';
import { OTP_SMS_MESSAGES } from './otp-messages';

describe('OTP SMS wording and encoding (no real SMS)', () => {
  let post: jest.Mock<
    Observable<{ data: KeccelOtpGenerateResponse }>,
    [string, Record<string, unknown>, AxiosRequestConfig]
  >;
  let service: KeccelOtpService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    post = jest.fn(() =>
      of({
        data: { status: 'SENT' as const, description: 'Message submitted' },
      }),
    );
    service = new KeccelOtpService(
      { post } as unknown as HttpService,
      new ConfigService({ KECCEL_TOKEN: 'test-token', KECCEL_FROM: 'Zwanga' }),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it.each(Object.entries(OTP_SMS_MESSAGES))(
    'sends the %s template without characters that can turn into mojibake',
    async (_name, message) => {
      await service.sendOtp('+243891234567', message, 6, 300);

      expect(post).toHaveBeenCalledTimes(1);
      const [, body, options] = post.mock.calls[0];
      expect(body).toEqual({
        token: 'test-token',
        from: 'Zwanga',
        to: '243891234567',
        message,
        length: 6,
        lifetime: 300,
      });
      expect(options.headers?.['Content-Type']).toBe(
        'application/json; charset=utf-8',
      );
      expect(message).toMatch(/^[\x20-\x7e]+$/);
      expect(message.match(/%OTP%/g)).toHaveLength(1);
      expect(message).toContain('Ne partagez ce code avec personne.');
      // Even a legacy Latin-1 decoder must preserve the exact outbound text.
      expect(Buffer.from(message, 'utf8').toString('latin1')).toBe(message);
    },
  );

  it('uses the same safe wording for the default OTP message', async () => {
    await service.sendOtp('+243891234567');
    const [, body] = post.mock.calls[0];
    expect(body.message).toBe(OTP_SMS_MESSAGES.default);
    expect(body.length).toBe(5);
    expect(body.lifetime).toBe(300);
  });

  it.each([
    ['+352 26 00 00', '352260000'],
    ['0032 2 000 00 00', '3220000000'],
    ['+683 4000', '6834000'],
    ['0900000000', '243900000000'],
  ])(
    'uses the same international normalization for Keccel send/check: %s',
    async (phone, expected) => {
      const request = jest
        .fn()
        .mockReturnValue(of({ data: { status: 'VALID' } }));
      const internationalService = new KeccelOtpService(
        { post, request } as unknown as HttpService,
        new ConfigService({
          KECCEL_TOKEN: 'test-token',
          KECCEL_FROM: 'Zwanga',
        }),
      );
      await internationalService.sendOtp(phone);
      expect(post.mock.calls[0][1].to).toBe(expected);
      await internationalService.verifyOtp(phone, '12345');
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ to: expected }),
        }),
      );
    },
  );

  it('does not silently remove accents from custom messages', async () => {
    const message = 'Code de sécurité : %OTP%';
    await service.sendOtp('+243891234567', message);
    expect(post.mock.calls[0][1].message).toBe(message);
  });

  it.each(['didit'])(
    'does not require Keccel credentials when %s is selected',
    async (provider) => {
      const inactiveKeccel = new KeccelOtpService(
        { post } as unknown as HttpService,
        new ConfigService({ OTP_PROVIDER: provider }),
      );

      await expect(
        inactiveKeccel.sendOtp('+243891234567'),
      ).rejects.toMatchObject({
        status: 503,
      });
      expect(post).not.toHaveBeenCalled();
    },
  );
});
