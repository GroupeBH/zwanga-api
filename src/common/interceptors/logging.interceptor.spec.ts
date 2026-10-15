import { ExecutionContext, HttpException, Logger, UnauthorizedException } from '@nestjs/common';
import { lastValueFrom, throwError } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';
import { ApiExceptionFilter } from '../filters/api-exception.filter';

describe('HTTP errors retain their meaning through logging and the exception filter', () => {
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method: 'PUT', url: '/api/v1/users/me', headers: {} }) }),
  } as ExecutionContext;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  async function dispatch(error: unknown) {
    const result = new LoggingInterceptor().intercept(context, { handle: () => throwError(() => error) });
    await expect(lastValueFrom(result)).rejects.toBe(error);
  }

  it.each([
    new Error('request aborted'),
    Object.assign(new Error('aborted'), { code: 'ECONNRESET' }),
    Object.assign(new Error('incomplete body'), { type: 'request.aborted' }),
    Object.assign(new Error('closed'), { code: 'ECONNABORTED' }),
  ])('leaves interrupted uploads to the rate-limited filter, never invents a 500', async error => {
    await dispatch(error);
    expect(Logger.prototype.error).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it.each([
    [new UnauthorizedException(), 401],
    [new HttpException('Request too large', 413), 413],
    [Object.assign(new Error('too many'), { statusCode: 429 }), 429],
  ])('does not report an expected HTTP refusal as a server crash', async (error, statusCode) => {
    await dispatch(error);
    expect(Logger.prototype.warn).toHaveBeenCalledWith('HTTP PUT /api/v1/users/me', expect.objectContaining({ statusCode, stack: undefined }));
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it.each([new Error('unexpected'), Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' }), null])(
    'retains real server errors and never replaces the original thrown value', async error => {
      await dispatch(error);
      expect(Logger.prototype.error).toHaveBeenCalledWith('HTTP PUT /api/v1/users/me', expect.objectContaining({ statusCode: 500 }));
    },
  );

  it('the Node request-aborted shape is handled without a second response or duplicate error log', async () => {
    const error = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    await dispatch(error);
    const response = { destroyed: true, status: jest.fn(), json: jest.fn() };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'PUT', url: '/api/v1/users/me', headers: {}, aborted: true }),
        getResponse: () => response,
      }),
    } as ExecutionContext;
    const filter = new ApiExceptionFilter();
    filter.catch(error, host);
    filter.catch(error, host);
    expect(Logger.prototype.error).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });
});
