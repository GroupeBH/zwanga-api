import { HttpService } from '@nestjs/axios';
import { ExecutionContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { defer, lastValueFrom, of, throwError } from 'rxjs';
import { ApiExceptionFilter } from '../common/filters/api-exception.filter';
import { LoggingInterceptor } from '../common/interceptors/logging.interceptor';
import { MobishastraSmsService } from './mobishastra-sms.service';

describe('Phone OTP confidentiality at the HTTP/logging boundary', () => {
  const phone = '243900000000';
  const code = '12345';
  const password = 'synthetic-sms-password';
  let logs: jest.SpyInstance[];
  beforeEach(() => {
    logs = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  function boundary(path: string) {
    const response = {
      statusCode: 200,
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          url: path,
          headers: {},
          body: { phone, otp: code },
        }),
        getResponse: () => response,
      }),
    } as ExecutionContext;
    return { response, context };
  }

  it('does not log the verification body or returned registration proof', async () => {
    const { context } = boundary('/api/v1/users/phone/verify');
    const result = { valid: true, verificationToken: 'synthetic-proof' };
    expect(
      await lastValueFrom(
        new LoggingInterceptor().intercept(context, {
          handle: () => of(result),
        }),
      ),
    ).toEqual(result);
    expect(logs[0]).toHaveBeenCalled();
    expect(
      JSON.stringify(logs.map((log): unknown => log.mock.calls)),
    ).not.toMatch(/12345|243900000000|synthetic-proof/);
  });

  it.each(['provider response', 'transport error'])(
    'does not expose secrets from a %s through the interceptor or exception filter',
    async (scenario) => {
      const echo = `${password} ${phone} ${code}`;
      const http = {
        get: jest.fn().mockReturnValue(
          scenario === 'provider response'
            ? of({ status: 200, data: `005 - Authorization failed ${echo}` })
            : throwError(() =>
                Object.assign(new Error(echo), {
                  config: {
                    params: { pwd: password, mobileno: phone, msgtext: code },
                  },
                  response: { data: echo },
                }),
              ),
        ),
      };
      const service = new MobishastraSmsService(
        new ConfigService({
          MOBISHASTRA_PROFILE_ID: 'synthetic-profile',
          MOBISHASTRA_PASSWORD: password,
          MOBISHASTRA_SENDER_ID: 'ZWANGA',
        }),
        http as unknown as HttpService,
      );
      const { context, response } = boundary('/api/v1/users/phone/send-otp');
      try {
        const result = new LoggingInterceptor().intercept(context, {
          handle: () => defer(() => service.sendCode(phone, code)),
        });
        await lastValueFrom(result).then(
          () => {
            throw new Error('Expected a sanitized SMS failure');
          },
          (error: unknown) => new ApiExceptionFilter().catch(error, context),
        );
        expect(http.get).toHaveBeenCalledTimes(1);
        expect(response.status).toHaveBeenCalledWith(503);
        expect(response.json).toHaveBeenCalledWith(
          expect.objectContaining({
            code: 'OTP_SMS_UNAVAILABLE',
          }),
        );
        const captured = JSON.stringify([
          ...logs.map((log): unknown => log.mock.calls),
          response.json.mock.calls,
        ]);
        for (const secret of [password, phone, code])
          expect(captured).not.toContain(secret);
      } finally {
        service.onModuleDestroy();
      }
    },
  );
});
