import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { MobishastraSmsService } from './mobishastra-sms.service';

describe('Mobishastra JSON SMS transport (no real SMS)', () => {
  const phone = '243900000000';
  const settings = {
    MOBISHASTRA_PROFILE_ID: 'test-profile',
    MOBISHASTRA_PASSWORD: 'private-password',
    MOBISHASTRA_SENDER_ID: 'ZWANGA',
  };
  const fixture = (extra = {}) => {
    const http = {
      post: jest
        .fn()
        .mockReturnValue(
          of({
            status: 200,
            data: [
              {
                msg_id: 'test-message',
                number: phone,
                response: 'send success',
              },
            ],
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

  it('uses the PDF JSON fields in a bounded HTTPS POST, without URL credentials', async () => {
    const { service, http } = fixture();
    await service.sendCode(phone, '12345');
    const [url, body, options] = http.post.mock.calls[0];
    expect(url).toBe('https://valuesms.ae/sendsms_api_json.aspx');
    expect(body).toEqual([
      {
        user: 'test-profile',
        pwd: 'private-password',
        sender: 'ZWANGA',
        number: phone,
        msg: expect.stringContaining('12345'),
        language: 'English',
      },
    ]);
    expect(body[0].msg).toMatch(/15 minutes/);
    expect(body[0].msg).toMatch(/^[\x20-\x7E]{1,160}$/);
    expect(options).toMatchObject({
      timeout: 10000,
      maxRedirects: 0,
      maxContentLength: 16384,
    });
    expect(warning).not.toHaveBeenCalled();
  });

  it.each(['Send Successful', 'SEND SUCCESS', ' send success '])(
    'recognizes the documented success response %s',
    async (response) => {
      const { service, http } = fixture();
      http.post.mockReturnValue(
        of({ status: 200, data: [{ msg_id: '1', number: phone, response }] }),
      );
      await expect(service.sendCode(phone, '12345')).resolves.toBeUndefined();
    },
  );

  it.each([
    'No More Credits',
    'Invalid Password',
    'Country not activated',
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
    http.post.mockReturnValue(of({ status: 200, data }));
    await expect(service.sendCode(phone, '12345')).rejects.toMatchObject({
      status: 503,
    });
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(
      /private-password|12345|243900000000/,
    );
  });

  it('does not retry a timeout or leak the Axios request body', async () => {
    const { service, http } = fixture();
    http.post.mockReturnValue(
      throwError(
        () => new Error('timeout private-password 12345 243900000000'),
      ),
    );
    await expect(service.sendCode(phone, '12345')).rejects.toMatchObject({
      status: 503,
      response: { code: 'OTP_SMS_UNAVAILABLE' },
    });
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith('MOBISHASTRA_SMS_NOT_CONFIRMED');
  });

  it.each([
    { MOBISHASTRA_PASSWORD: '' },
    { MOBISHASTRA_PROFILE_ID: '' },
    { MOBISHASTRA_SENDER_ID: '' },
    { MOBISHASTRA_SMS_URL: 'http://valuesms.ae/sendsms_api_json.aspx' },
    { MOBISHASTRA_SMS_URL: 'https://attacker.invalid/sendsms_api_json.aspx' },
    {
      MOBISHASTRA_SMS_URL:
        'https://valuesms.ae/sendsms_api_json.aspx?pwd=secret',
    },
  ])('fails closed for unsafe/missing configuration %j', async (extra) => {
    const { service, http } = fixture(extra);
    await expect(service.sendCode(phone, '12345')).rejects.toMatchObject({
      status: 503,
    });
    expect(http.post).not.toHaveBeenCalled();
  });
});
