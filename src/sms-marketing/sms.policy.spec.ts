import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SmsEstimateDto } from './sms.dto';
import { SmsMarketingConfig } from './sms.config';
import {
  inSendingWindow,
  maskPhone,
  optOutCode,
  permissions,
  renderSms,
  smsLength,
  validateMessage,
} from './sms.policy';
import {
  marketingResult,
  MobishastraMarketingTransport,
} from './mobishastra-marketing.transport';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { safeRequestError, safeRequestPath } from '../common/safe-request-log';

describe('SMS policies (no provider traffic)', () => {
  it.each([
    ['a'.repeat(160), 'gsm', 160, 1],
    ['a'.repeat(161), 'gsm', 161, 2],
    ['€', 'gsm', 2, 1],
    ['éèàùÉ', 'gsm', 5, 1],
    ['ê' + 'a'.repeat(70), 'unicode', 71, 2],
    ['🚗', 'unicode', 2, 1],
    ['', 'gsm', 0, 0],
  ])('counts the admin GSM/UTF16 case %s', (text, encoding, units, segments) =>
    expect(smsLength(String(text))).toEqual({ encoding, units, segments }),
  );
  it('renders an absent, long, accented or escaped name without stray spaces', () => {
    expect(renderSms('Bonjour {prenom},', null, ' Stop')).toBe('Bonjour, Stop');
    expect(renderSms('Salut {PRENOM} !', ' Émilie Dupont', '')).toBe(
      'Salut Émilie!',
    );
    expect(renderSms('{prenom}', 'a'.repeat(30), '')).toBe('a'.repeat(20));
    expect(renderSms('{prenom}', '\\1', '')).toBe('\\1');
    expect(renderSms('{prenom}', '😀'.repeat(25), '')).toBe('😀'.repeat(10));
    expect(() =>
      validateMessage(
        'Bonjour {prenom} !',
        ' Stop SMS: https://z.test/s/Ab3dE9xK',
      ),
    ).not.toThrow();
  });
  it('validates unknown or malformed placeholders and worst-case personalization', () => {
    for (const text of [
      '',
      ' ',
      '{ville}',
      '{x1}',
      '{prenom',
      'a'.repeat(161),
      'Bonjour {prenom}' + 'a'.repeat(100),
    ])
      expect(() => validateMessage(text, '')).toThrow();
    expect(() => validateMessage('Bonjour {prenom}', '')).not.toThrow();
  });
  it.each([
    ['2026-11-27T06:59:59Z', false],
    ['2026-11-27T07:00:00Z', true],
    ['2026-11-27T18:59:59Z', true],
    ['2026-11-27T19:00:00Z', false],
  ])('uses Kinshasa, not the host timezone: %s', (date, open) =>
    expect(inSendingWindow(new Date(date), '08:00', '20:00')).toBe(open),
  );
  it('uses random base62 eight-character bearer codes', () => {
    const codes = Array.from({ length: 10000 }, optOutCode);
    expect(new Set(codes).size).toBe(10000);
    expect(codes.every((c) => /^[0-9A-Za-z]{8}$/.test(c))).toBe(true);
  });
  it.each(['passenger', 'driver', 'unknown'])('denies public role %s', (role) =>
    expect(permissions(role)).toEqual([]),
  );
  it('separates marketer edit rights from send and opt-out rights', () => {
    expect(permissions('marketer')).toEqual(['sms.read', 'sms.write']);
    expect(permissions('admin')).toHaveLength(4);
    expect(permissions('super_admin')).toHaveLength(4);
  });
  it('defaults off, has no implicit sender/short domain or approval', () => {
    const config = new SmsMarketingConfig(
      new ConfigService({ MOBISHASTRA_SENDER_ID: 'OTP' }),
    );
    expect(config.enabled).toBe(false);
    expect(config.sender).toBeNull();
    expect(config.baseUrl).toBeNull();
    expect(config.approved).toBe(false);
    expect(() => config.assertEnabled()).toThrow();
  });
  it('enables admin access independently of provider approval and real sending', async () => {
    const config = new SmsMarketingConfig(
      new ConfigService({
        SMS_MARKETING_ENABLED: 'true',
        SMS_MARKETING_PROVIDER_CONFIRMED: 'false',
        SMS_MARKETING_SENDER_ID: '',
        SMS_MARKETING_OPT_OUT_BASE_URL: '',
        SMS_MARKETING_LINK_HOST: '',
      }),
    );
    const get = jest.fn();
    const transport = new MobishastraMarketingTransport(config, {
      get,
    } as unknown as HttpService);
    expect(config.enabled).toBe(true);
    expect(() => config.assertEnabled()).not.toThrow();
    expect(permissions('admin')).toContain('sms.send');
    expect(permissions('super_admin')).toContain('sms.send');
    expect(config.approved).toBe(false);
    expect(transport.configured()).toBe(false);
    expect(await transport.send('+243900000001', 'Test')).toEqual({
      accepted: false,
      code: 'PROVIDER_NOT_CONFIRMED',
    });
    expect(get).not.toHaveBeenCalled();
  });
  it.each([
    'http://zwanga.test/s/',
    'https://evil.test/s/',
    'https://zwanga.test/s/?x=',
    'https://u:p@zwanga.test/s/',
  ])('refuses an unapproved/unsafe link: %s', (url) => {
    expect(
      new SmsMarketingConfig(
        new ConfigService({
          SMS_MARKETING_LINK_HOST: 'zwanga.test',
          SMS_MARKETING_OPT_OUT_BASE_URL: url,
        }),
      ).baseUrl,
    ).toBeNull();
  });
  it('masks phone and bearer paths in logs and errors', () => {
    expect(maskPhone('+243900000001')).not.toContain('900000001');
    const req = { url: '/api/v1/sms/s/Ab3dE9xK?phone=secret' };
    expect(safeRequestPath(req)).toBe('/api/v1/sms/s/[redacted]');
    expect(
      safeRequestError('Failure ' + req.url + ' Ab3dE9xK', req),
    ).not.toContain('Ab3dE9xK');
  });
  it('requires a nested audience and rejects malformed dates/phones', async () => {
    expect(
      (await validate(plainToInstance(SmsEstimateDto, { message: 'Hello' })))
        .length,
    ).toBeGreaterThan(0);
    expect(
      (
        await validate(
          plainToInstance(SmsEstimateDto, {
            message: 'Hello',
            audience: { signedUpFrom: '2026-02-30', phones: ['abc'] },
          }),
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
describe('Mobishastra marketing result and confidentiality', () => {
  it.each(['000', '000 - Send Successful', 'Send Successful'])(
    'confirms only an exact documented success: %s',
    (body) => expect(marketingResult(200, body)).toEqual({ accepted: true }),
  );
  it.each([
    '',
    '000 - Send Successful SECRET',
    '000 - error',
    '<html>Send Successful</html>',
  ])('does not infer acceptance: %s', (body) =>
    expect(marketingResult(200, body)).toEqual({
      accepted: false,
      code: 'PROVIDER_NOT_CONFIRMED',
    }),
  );
  it.each([
    ['No More Credits', 'INSUFFICIENT_CREDITS'],
    ['001 - Invalid Receiver', 'INVALID_NUMBER'],
    ['012 - Sender Id more than 13 Chars', 'SENDER_NOT_APPROVED'],
    ['006', 'OPERATOR_REJECTED'],
    ['013', 'PROVIDER_UNAVAILABLE'],
  ])('maps documented response %s', (body, code) =>
    expect(marketingResult(200, body)).toEqual({ accepted: false, code }),
  );
  const config = () =>
    new SmsMarketingConfig(
      new ConfigService({
        SMS_MARKETING_PROVIDER_CONFIRMED: 'true',
        SMS_MARKETING_SENDER_ID: 'ZWANGA',
        SMS_MARKETING_LINK_HOST: 'zwanga.test',
        SMS_MARKETING_OPT_OUT_BASE_URL: 'https://zwanga.test/s/',
        MOBISHASTRA_PROFILE_ID: 'synthetic-profile',
        MOBISHASTRA_PASSWORD: 'synthetic-secret',
        MOBISHASTRA_PROXY_URL: 'http://127.0.0.1:13128',
        NODE_ENV: 'test',
      }),
    );
  it('bounds requests and does not retry or leak an ambiguous error', async () => {
    const http = {
      get: jest.fn(() =>
        throwError(() => new Error('synthetic-secret +243900000001 message')),
      ),
    };
    const transport = new MobishastraMarketingTransport(
      config(),
      http as unknown as HttpService,
    );
    try {
      expect(await transport.send('+243900000001', 'Hello')).toEqual({
        accepted: false,
        code: 'PROVIDER_NOT_CONFIRMED',
      });
      expect(http.get).toHaveBeenCalledTimes(1);
      expect(http.get.mock.calls[0][1]).toMatchObject({
        maxRedirects: 0,
        proxy: false,
        timeout: 10000,
      });
    } finally {
      transport.onModuleDestroy();
    }
  });
  it('does not invent Unicode transport options from an incomplete PDF', async () => {
    const http = { get: jest.fn(() => of({ status: 200, data: '000' })) };
    const transport = new MobishastraMarketingTransport(
      config(),
      http as unknown as HttpService,
    );
    expect(await transport.send('+243900000001', 'déjà')).toEqual({
      accepted: false,
      code: 'SMS_ENCODING_UNCONFIRMED',
    });
    expect(http.get).not.toHaveBeenCalled();
    transport.onModuleDestroy();
  });
  it('does not submit more than one GSM segment composed of extension characters', async () => {
    const http = { get: jest.fn() };
    const transport = new MobishastraMarketingTransport(
      config(),
      http as unknown as HttpService,
    );
    expect(await transport.send('+243900000001', '^'.repeat(81))).toEqual({
      accepted: false,
      code: 'SMS_ENCODING_UNCONFIRMED',
    });
    expect(http.get).not.toHaveBeenCalled();
    transport.onModuleDestroy();
  });
});
