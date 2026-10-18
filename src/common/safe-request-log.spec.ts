import { safeRequestError, safeRequestPath } from './safe-request-log';

describe('sensitive request log redaction', () => {
  it.each(['/api/v1/tracking/public/synthetic-secret?token=synthetic-query',
    '/api/v1/tracking/public/synthetic%2Dsecret?code=synthetic-query',
    '/api/v1/%74racking/public/synthetic-secret?code=synthetic-query'])('masks %s', url => {
    const request = { originalUrl: url };
    expect(safeRequestPath(request)).toBe('/api/v1/tracking/public/[redacted]');
    const text = safeRequestError(`Error GET ${url}\n at handler(${decodeURIComponent(url)})`, request)!;
    expect(text).not.toContain('synthetic-secret');
    expect(text).not.toContain('synthetic-query');
  });
  it('strips query values on ordinary routes, preserves routing and removes control characters', () => {
    expect(safeRequestPath({ url: '/api/v1/trips?page=1&accessToken=secret' })).toBe('/api/v1/trips');
    expect(safeRequestPath({ url: '/api/v1/trips%0Aforged-log' })).not.toContain('\n');
    expect(safeRequestPath({})).toBe('/');
  });
});
