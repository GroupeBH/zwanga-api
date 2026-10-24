import express from 'express';
import request from 'supertest';
import { configureHttpSecurity } from './http-security';

describe('HTTP origin security headers', () => {
  function createApp(prefix = 'api/v1') {
    const app = express();
    configureHttpSecurity(app, prefix);
    app.use(express.json());
    app.get('/api/v1/docs', (_req, res) =>
      res.type('html').send('<html>Swagger</html>'),
    );
    app.get('/uploads/public.jpg', (_req, res) =>
      res.set('Cache-Control', 'public, max-age=3600').send('fixture'),
    );
    app.use((req, res) =>
      res.status(req.path.endsWith('/denied') ? 401 : 200).json({ ok: true }),
    );
    return app;
  }

  it.each([
    '/health/live',
    '/api/v1/trips',
    '/api/v1/users/me',
    '/api/v1/docs',
  ])(
    'removes the framework fingerprint and sets nosniff on %s',
    async (path) => {
      const response = await request(createApp()).get(path).expect(200);
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    },
  );
  it.each([
    '/api/v1/auth',
    '/api/v1/auth/login',
    '/api/v1/auth/refresh',
    '/api/v1/users/kyc',
    '/api/v1/users/kyc/didit/session',
    '/api/v1/users/kyc/didit/sync',
    '/api/v1/users/kyc/aws/session',
    '/API/V1/AUTH/LOGIN',
  ])('disables cache for %s even without a JWT', async (path) => {
    await request(createApp())
      .post(path)
      .send({})
      .expect('Cache-Control', 'private, no-store')
      .expect(200);
  });
  it.each([
    ['GET', '/api/v1/users/me', 200],
    ['HEAD', '/api/v1/wallet/me', 200],
    ['GET', '/api/v1/admin/denied', 401],
  ] as const)(
    'disables cache for authenticated %s %s (%s)',
    async (method, path, status) => {
      const probe = request(createApp());
      await (method === 'HEAD' ? probe.head(path) : probe.get(path))
        .set('Authorization', 'Bearer synthetic')
        .expect(status)
        .expect('Cache-Control', 'private, no-store');
    },
  );
  it('honors a custom API prefix', async () => {
    await request(createApp('/custom/api/'))
      .post('/custom/api/auth/login')
      .expect('Cache-Control', 'private, no-store');
  });
  it('does not match unrelated public paths', async () => {
    const response = await request(createApp()).get('/api/v1/authors');
    expect(response.headers['cache-control']).toBeUndefined();
  });
  it('preserves public media cache policy', async () => {
    await request(createApp())
      .get('/uploads/public.jpg')
      .expect('Cache-Control', 'public, max-age=3600')
      .expect('X-Content-Type-Options', 'nosniff');
  });
  it('does not introduce CSP/HSTS or prevent Swagger HTML rendering in local HTTP', async () => {
    const response = await request(createApp())
      .get('/api/v1/docs')
      .expect('Content-Type', /html/);
    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });
  it('sets headers even on malformed JSON rejected by the parser', async () => {
    await request(createApp())
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400)
      .expect('Cache-Control', 'private, no-store')
      .expect('X-Content-Type-Options', 'nosniff');
  });
});
