import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';
import { ApiExceptionFilter } from './api-exception.filter';
import { DriverScheduleConflictException } from '../driver-schedule-conflict';

function createHttpHost(options?: {
  aborted?: boolean;
  headersSent?: boolean;
  userId?: string;
}) {
  const request = {
    method: 'POST',
    originalUrl: '/api/v1/users/kyc',
    url: '/api/v1/users/kyc',
    headers: {},
    aborted: options?.aborted ?? false,
    user: options?.userId ? { userId: options.userId } : undefined,
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

  it('returns only the authenticated driver’s conflicting course summary, not the whole entity', () => {
    const row = { kind: 'trip' as const, id: 'trip', driverId: 'driver', departure: 'Test A', arrival: 'Test B',
      departureDate: new Date('2099-01-01T12:00:00Z'), status: 'upcoming', passengerPhone: 'must not escape' };
    const { host, response } = createHttpHost({ userId: 'driver' });
    filter.catch(new DriverScheduleConflictException(row), host);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DRIVER_SCHEDULE_CONFLICT', conflict: {
      kind: 'trip', id: 'trip', driverId: 'driver', departure: 'Test A', arrival: 'Test B',
      departureDate: '2099-01-01T12:00:00.000Z', status: 'upcoming',
    } }));
    expect(JSON.stringify(response.json.mock.calls)).not.toContain('must not escape');
  });

  it.each([undefined, 'passenger', 'other-driver'])('never reveals a driver’s schedule to %s', userId => {
    const { host, response } = createHttpHost({ userId });
    const exception = new DriverScheduleConflictException({ kind: 'request', id: 'request', driverId: 'driver',
      departure: 'Private location', arrival: 'Private destination', departureDate: new Date(), status: 'driver_selected' });
    filter.catch(exception, host);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json.mock.calls[0][0]).not.toHaveProperty('conflict');
    expect(JSON.stringify(response.json.mock.calls)).not.toContain('Private');
    expect(exception.getResponse()).not.toHaveProperty('conflict');
  });

  it('turns a protected cash hold into an actionable conflict without leaking SQL', () => {
    const { host, response } = createHttpHost();
    filter.catch({ driverError: { code: '23514', constraint: 'CHK_wallet_cash_reserve', message: 'private balances' } }, host);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'WALLET_FUNDS_RESERVED' }));
    expect(JSON.stringify(response.json.mock.calls)).not.toContain('private balances');
  });

  it.each(['55P03', '40P01', '40001', '53300', '57P01', '08006'])('reports temporary database failure %s without retrying a financial operation', code => {
    const { host, response } = createHttpHost();
    filter.catch({ driverError: { code } }, host);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DATABASE_TEMPORARILY_UNAVAILABLE', message: expect.stringContaining('statut') }));
  });

  it('translates only known database business errors into actionable conflicts', () => {
    const { host, response } = createHttpHost();
    filter.catch({ driverError: { code: 'P0001', message: 'CASH_COMMISSION_INSUFFICIENT' } }, host);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CASH_COMMISSION_INSUFFICIENT', message: expect.stringContaining('5 %') }));
    const unknown = createHttpHost();
    filter.catch({ driverError: { code: 'P0001', message: 'private SQL detail' } }, unknown.host);
    expect(unknown.response.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(unknown.response.json.mock.calls)).not.toContain('private SQL detail');
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

  it('recognizes the Node incoming-body reset without masking generic upstream resets', () => {
    const { host, response } = createHttpHost();
    filter.catch(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }), host);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'REQUEST_ABORTED' }));
    const upstream = createHttpHost();
    filter.catch(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), upstream.host);
    expect(upstream.response.status).toHaveBeenCalledWith(500);
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
