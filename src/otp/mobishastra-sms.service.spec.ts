import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import { Observable, of, throwError } from 'rxjs';
import type { AxiosRequestConfig } from 'axios';
import { Agent } from 'node:https';
import { MobishastraSmsService } from './mobishastra-sms.service';

describe('Mobishastra single-message SMS transport (no real SMS)', () => {
  const phone = '243900000000';
  const settings = {
    MOBISHASTRA_PROFILE_ID: 'test-profile',
    MOBISHASTRA_PASSWORD: 'private-password',
    MOBISHASTRA_SENDER_ID: 'ZWANGA',
  };
  const fixture = (extra = {}) => {
    const http = {
      get: jest
        .fn<
          Observable<{ status: number; data: unknown }>,
          [string, AxiosRequestConfig]
        >()
        .mockReturnValue(
          of({
            status: 200,
            data: '000 - Send Successful',
          }),
        ),
    };
    return {
      http,
      service: new MobishastraSmsService(
        new ConfigService({ ...settings, ...extra }),
        http as unknown as HttpService,
      ),
    };
  };
  let warning: jest.SpyInstance;
  beforeEach(() => {
    warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('uses the single-message endpoint and PDF fields in a bounded HTTPS GET', async () => {
    const { service, http } = fixture();
    await service.sendCode(phone, '12345');
    const [url, options] = http.get.mock.calls[0];
    expect(url).toBe('https://mshastra.com/sendurl.aspx');
    expect(options.params).toEqual({
      user: 'test-profile',
      pwd: 'private-password',
      senderid: 'ZWANGA',
      mobileno: phone,
      msgtext:
        'Zwanga : votre code de verification est 12345. Valable 15 minutes. Ne le partagez avec personne.',
      priority: 'High',
      CountryCode: 'ALL',
      ShowError: 'C',
    });
    const { msgtext } = options.params as { msgtext: string };
    expect(msgtext).toMatch(/15 minutes/);
    expect(msgtext).toMatch(/^[\x20-\x7E]{1,160}$/);
    expect(options).toMatchObject({
      proxy: false,
      adapter: 'http',
      timeout: 10000,
      maxRedirects: 0,
      maxContentLength: 16384,
      responseType: 'text',
      headers: { Accept: 'text/plain', 'Cache-Control': 'no-store' },
    });
    expect(warning).not.toHaveBeenCalled();
  });

  it('routes only the SMS request through the configured proxy, never the payload', async () => {
    const { service, http } = fixture({
      MOBISHASTRA_PROXY_URL: 'http://10.42.0.123:3128',
      MOBISHASTRA_PROXY_REQUIRED: 'true',
      NODE_ENV: 'production',
    });
    await service.sendCode(phone, '12345');
    const [, options] = http.get.mock.calls[0];
    expect(options.proxy).toBe(false);
    const agent = options.httpsAgent as Agent;
    expect((agent.options as { proxyEnv?: unknown }).proxyEnv).toEqual({
      https_proxy: 'http://10.42.0.123:3128',
    });
    expect(agent.options.rejectUnauthorized).toBe(true);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.params).not.toHaveProperty('proxy');
    service.onModuleDestroy();
  });

  it.each(['pin_reset', 'pin_change'] as const)(
    'sends six digits for %s in a single SMS without logging the code',
    async (purpose) => {
      const { service, http } = fixture();
      await service.sendCode(phone, '123456', purpose);
      const params = http.get.mock.calls[0][1].params as { msgtext: string };
      expect(params.msgtext).toContain('PIN');
      expect(params.msgtext).toContain('123456');
      expect(params.msgtext).toMatch(/^[\x20-\x7E]{1,160}$/);
      expect(warning).not.toHaveBeenCalled();
      await expect(
        service.sendCode(phone, '12345', purpose),
      ).rejects.toMatchObject({ status: 503 });
      expect(http.get).toHaveBeenCalledTimes(1);
      service.onModuleDestroy();
    },
  );

  it('does not attempt direct delivery when a required proxy is missing', async () => {
    const { service, http } = fixture({ MOBISHASTRA_PROXY_REQUIRED: 'true' });
    await expect(service.sendCode(phone, '12345')).rejects.toMatchObject({
      response: { code: 'OTP_SMS_PROXY_MISCONFIGURED' },
    });
    expect(http.get).not.toHaveBeenCalled();
  });

  it('fails closed on a Node runtime that cannot enforce the native proxy', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      process.versions,
      'node',
    )!;
    try {
      Object.defineProperty(process.versions, 'node', {
        ...descriptor,
        value: '22.0.0',
      });
      const { service, http } = fixture({
        MOBISHASTRA_PROXY_URL: 'http://10.42.0.123:3128',
      });
      await expect(service.sendCode(phone, '12345')).rejects.toMatchObject({
        response: { code: 'OTP_SMS_PROXY_MISCONFIGURED' },
      });
      expect(http.get).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.versions, 'node', descriptor);
    }
  });

  it.each([
    'Send Successful',
    '000',
    '000 - Send Successful',
    ' 000 - SEND SUCCESSFUL\r\n',
  ])('recognizes the documented success response %s', async (response) => {
    const { service, http } = fixture();
    http.get.mockReturnValue(of({ status: 200, data: response }));
    await expect(service.sendCode(phone, '12345')).resolves.toBeUndefined();
  });

  it.each([
    'No More Credits',
    'Invalid Password',
    'Country not activated',
    '005 - Authorization failed',
    '013 - Server Error',
    '000 - Send Successful\n005 - Authorization failed',
    'not Send Successful',
    'Send Successful private-password 12345 243900000000',
    '',
    0,
    '<html>error</html>',
    null,
    [],
    [{ number: phone, response: 'send success' }],
    [{ msg_id: '1', number: '243900000001', response: 'send success' }],
    [{ msg_id: '1', number: phone, response: 'not send success' }],
    [
      { msg_id: '1', number: phone, response: 'send success' },
      { response: 'send success' },
    ],
  ])('rejects an HTTP 200 with failed/ambiguous payload %j', async (data) => {
    const { service, http } = fixture();
    http.get.mockReturnValue(of({ status: 200, data }));
    await expect(service.sendCode(phone, '12345')).rejects.toMatchObject({
      status: 503,
    });
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(
      /private-password|12345|243900000000/,
    );
  });

  it('does not retry a timeout or leak Axios parameters, response or stack', async () => {
    const { service, http } = fixture();
    http.get.mockReturnValue(
      throwError(
        () => new Error('timeout private-password 12345 243900000000'),
      ),
    );
    await expect(service.sendCode(phone, '12345')).rejects.toMatchObject({
      status: 503,
      response: { code: 'OTP_SMS_UNAVAILABLE' },
    });
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith('MOBISHASTRA_SMS_NOT_CONFIRMED');
  });

  it.each([
    { MOBISHASTRA_PASSWORD: '' },
    { MOBISHASTRA_PROFILE_ID: '' },
    { MOBISHASTRA_SENDER_ID: '' },
    { MOBISHASTRA_SMS_URL: 'http://valuesms.ae/sendsms_api_json.aspx' },
    { MOBISHASTRA_SMS_URL: 'https://valuesms.ae/sendsms_api_json.aspx' },
    { MOBISHASTRA_SMS_URL: 'https://mshastra.com/sendsms_api_json.aspx' },
    { MOBISHASTRA_SMS_URL: 'http://mshastra.com/sendurl.aspx' },
    { MOBISHASTRA_SMS_URL: 'https://attacker.invalid/sendsms_api_json.aspx' },
    {
      MOBISHASTRA_SMS_URL: 'https://mshastra.com/sendurl.aspx?pwd=secret',
    },
  ])('fails closed for unsafe/missing configuration %j', async (extra) => {
    const { service, http } = fixture(extra);
    await expect(service.sendCode(phone, '12345')).rejects.toMatchObject({
      status: 503,
    });
    expect(http.get).not.toHaveBeenCalled();
  });
});
