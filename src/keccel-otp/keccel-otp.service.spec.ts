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

  it('does not silently remove accents from custom messages', async () => {
    const message = 'Code de sécurité : %OTP%';
    await service.sendOtp('+243891234567', message);
    expect(post.mock.calls[0][1].message).toBe(message);
  });
});
