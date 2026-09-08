import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';
import { ApiExceptionFilter } from './api-exception.filter';

function createHttpHost(options?: {
  aborted?: boolean;
  headersSent?: boolean;
}) {
  const request = {
    method: 'POST',
    originalUrl: '/api/v1/users/kyc',
    url: '/api/v1/users/kyc',
    headers: {},
    aborted: options?.aborted ?? false,
  };
  const response = {
    headersSent: options?.headersSent ?? false,
    writableEnded: false,
    destroyed: false,
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as ArgumentsHost;

  return { host, request, response };
}

describe('ApiExceptionFilter', () => {
  let filter: ApiExceptionFilter;

  beforeEach(() => {
    filter = new ApiExceptionFilter();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a stable, user-facing error for an incomplete request body', () => {
    const { host, response } = createHttpHost();
    const error = Object.assign(new Error('request aborted'), {
      code: 'ECONNABORTED',
      type: 'request.aborted',
      expected: 157,
      received: 0,
    });

    filter.catch(error, host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        code: 'REQUEST_ABORTED',
        error: 'Requête incomplète',
        message: expect.not.stringContaining('request aborted'),
        path: '/api/v1/users/kyc',
      }),
    );
  });

  it('does not try to write a response after the client closed the socket', () => {
    const { host, response } = createHttpHost({ aborted: true });
    const error = Object.assign(new Error('request aborted'), {
      code: 'ECONNABORTED',
      type: 'request.aborted',
    });

    filter.catch(error, host);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it('maps malformed JSON to an actionable validation error', () => {
    const { host, response } = createHttpHost();
    const error = Object.assign(new SyntaxError('Unexpected token'), {
      status: 400,
      type: 'entity.parse.failed',
    });

    filter.catch(error, host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_REQUEST_BODY' }),
    );
  });

  it('turns a rejected CORS origin into a 403 instead of a 500', () => {
    const { host, response } = createHttpHost();

    filter.catch(
      new Error('Origin https://example.test is not allowed by CORS'),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'CORS_ORIGIN_FORBIDDEN' }),
    );
  });

  it('preserves explicit business validation messages', () => {
    const { host, response } = createHttpHost();

    filter.catch(
      new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'VEHICLE_HAS_ACTIVE_TRIPS',
        message: 'Ce véhicule possède encore un trajet actif.',
      }),
      host,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'VEHICLE_HAS_ACTIVE_TRIPS',
        message: 'Ce véhicule possède encore un trajet actif.',
      }),
    );
  });

  it('does not expose unexpected internal error details', () => {
    const { host, response } = createHttpHost();

    filter.catch(new Error('database password leaked here'), host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'INTERNAL_SERVER_ERROR',
        message: expect.not.stringContaining('database password'),
      }),
    );
  });
});
