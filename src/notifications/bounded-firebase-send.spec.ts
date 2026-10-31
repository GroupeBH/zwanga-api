import { createServer, type Server } from 'node:http';
import { sendBoundedFirebase, firebaseWireMessage, FCM_AUTH_TIMEOUT_MS, FCM_SEND_TIMEOUT_MS } from './bounded-firebase-send';
import type { App } from 'firebase-admin/app';

describe('bounded urgent Firebase HTTP v1 transport (loopback only)', () => {
  let server: Server, url: string, mode: string, requests: any[], closed: number;
  const realFetch = global.fetch;
  const app = (): App => ({ options: { projectId: 'local-test', credential: {
    getAccessToken: jest.fn().mockResolvedValue({ access_token: 'synthetic-local-only', expires_in: 3600 }),
  } } } as unknown as App);
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = ''; for await (const part of req) body += part;
      requests.push(JSON.parse(body));
      if (mode === 'slow') { res.on('close', () => closed++); return; }
      if (mode === 'slow-body') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{'); res.on('close', () => closed++); return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = mode === 'unregistered' ? 404 : 200;
      res.end(JSON.stringify(mode === 'unregistered' ? { error: { details: [{ errorCode: 'UNREGISTERED' }] } } : { name: 'local/receipt' }));
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(server.address() as any).port}`;
    jest.spyOn(global, 'fetch').mockImplementation((_url, options) => realFetch(url, options));
  });
  beforeEach(() => { mode = 'ok'; requests = []; closed = 0; });
  afterAll(async () => { jest.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  it('sends one request with public HTTP v1 Android and APNs keys', async () => {
    const result = await sendBoundedFirebase(app(), { token: 'test-token', android: { priority: 'high', ttl: 60000,
      notification: { channelId: 'ride', visibility: 'private' } }, apns: { payload: { aps: {
        sound: 'driver_ring.wav', threadId: 'ride', contentAvailable: true, mutableContent: false,
      } } } });
    expect(result).toBe('local/receipt'); expect(requests).toHaveLength(1);
    expect(requests[0].message.android).toEqual({ priority: 'HIGH', ttl: '60.000s', notification: { channel_id: 'ride', visibility: 'PRIVATE' } });
    expect(requests[0].message.apns.payload.aps).toMatchObject({ 'thread-id': 'ride', 'content-available': 1, 'mutable-content': 0 });
    expect(firebaseWireMessage({ token: 'x', data: { a: 'b' } })).toEqual({ token: 'x', data: { a: 'b' } });
  });
  it.each(['slow', 'slow-body'])('aborts a stalled response (%s) and makes no hidden retry', async responseMode => {
    mode = responseMode; const start = Date.now();
    await expect(sendBoundedFirebase(app(), { token: 'test' }, 150)).rejects.toMatchObject({
      message: 'FCM_SEND_TIMEOUT', code: 'messaging/send-timeout',
      details: { phase: 'send', transient: true, timeoutMs: 150 },
    });
    await new Promise(done => setTimeout(done, 50));
    expect(Date.now()-start).toBeLessThan(1500); expect(requests).toHaveLength(1); expect(closed).toBe(1);
  });
  it('bounds callers while coalescing a stuck OAuth lookup without starting sends', async () => {
    const a = app(); (a.options.credential!.getAccessToken as jest.Mock).mockReturnValue(new Promise(() => {}));
    await Promise.all(Array.from({ length: 8 }, () => expect(sendBoundedFirebase(a, { token: 'test' }, 20)).rejects.toThrow('FCM_AUTH_TIMEOUT')));
    expect(a.options.credential!.getAccessToken).toHaveBeenCalledTimes(1); expect(requests).toHaveLength(0);
  });
  it('preserves invalid-token classification without logging its value', async () => {
    mode = 'unregistered'; await expect(sendBoundedFirebase(app(), { token: 'test' })).rejects.toMatchObject({ code: 'messaging/registration-token-not-registered' });
  });
});

describe('Firebase deadlines and safe failure diagnostics (no provider calls)', () => {
  const app = (): App => ({ options: { projectId: 'local-test', credential: {
    getAccessToken: jest.fn().mockResolvedValue({ access_token: 'synthetic-local-only', expires_in: 3600 }),
  } } } as unknown as App);
  const ok = () => new Response(JSON.stringify({ name: 'local/receipt' }), { status: 200 });
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it('gives FCM its full send window after a slow cold credential refresh', async () => {
    const a = app();
    (a.options.credential!.getAccessToken as jest.Mock).mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve({ access_token: 'synthetic', expires_in: 3600 }), 4_500);
    }));
    const send = jest.spyOn(global, 'fetch').mockImplementation((_url, options) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(ok()), 11_000);
      options!.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    }));
    const result = sendBoundedFirebase(a, { token: 'test' });
    const success = expect(result).resolves.toBe('local/receipt');
    await jest.advanceTimersByTimeAsync(4_500);
    expect(send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(11_000);
    await success;
    expect(send.mock.calls[0][1]!.signal!.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds a stalled send to 15 seconds with a stable, retryable error', async () => {
    const send = jest.spyOn(global, 'fetch').mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('raw network detail')), { once: true });
    }));
    const result = sendBoundedFirebase(app(), { token: 'test' });
    const failure = expect(result).rejects.toMatchObject({ message: 'FCM_SEND_TIMEOUT', details: { timeoutMs: 15_000, transient: true } });
    await jest.advanceTimersByTimeAsync(FCM_SEND_TIMEOUT_MS);
    await failure;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not send late after an auth timeout and reuses a subsequently resolved token', async () => {
    const a = app();
    let release!: (value: { access_token: string; expires_in: number }) => void;
    (a.options.credential!.getAccessToken as jest.Mock).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const send = jest.spyOn(global, 'fetch').mockResolvedValue(ok());
    const result = sendBoundedFirebase(a, { token: 'test' });
    const failure = expect(result).rejects.toMatchObject({ message: 'FCM_AUTH_TIMEOUT', details: { phase: 'auth', timeoutMs: 5_000 } });
    await jest.advanceTimersByTimeAsync(FCM_AUTH_TIMEOUT_MS);
    await failure;
    expect(send).not.toHaveBeenCalled();
    release({ access_token: 'synthetic', expires_in: 3600 });
    await jest.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    await expect(sendBoundedFirebase(a, { token: 'test' })).resolves.toBe('local/receipt');
    expect(a.options.credential!.getAccessToken).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refreshes cached OAuth credentials on the next attempt even after a non-JSON 401', async () => {
    const a = app();
    const send = jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(ok());
    await expect(sendBoundedFirebase(a, { token: 'test' })).rejects.toMatchObject({
      message: 'FCM_HTTP_401', details: { phase: 'send', transient: false, httpStatus: 401 },
    });
    expect(send).toHaveBeenCalledTimes(1);
    await expect(sendBoundedFirebase(a, { token: 'test' })).resolves.toBe('local/receipt');
    expect(a.options.credential!.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it.each([429, 500, 503])('retains HTTP status %s on a non-JSON response without inline retry', async status => {
    const send = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('upstream error', { status }));
    await expect(sendBoundedFirebase(app(), { token: 'test' })).rejects.toMatchObject({
      message: `FCM_HTTP_${status}`, details: { transient: true, httpStatus: status },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['null', '{}', '{'])('does not record malformed success %s as delivery', async body => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
    await expect(sendBoundedFirebase(app(), { token: 'test' })).rejects.toMatchObject({ message: 'FCM_INVALID_RESPONSE' });
  });

  it('does not persist raw network errors or authentication secrets in diagnostics', async () => {
    const send = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('socket failed with SECRET'));
    await expect(sendBoundedFirebase(app(), { token: 'test' })).rejects.toMatchObject({
      message: 'FCM_NETWORK_ERROR', code: 'messaging/network-error', details: { phase: 'send', transient: true },
    });
    const a = app();
    (a.options.credential!.getAccessToken as jest.Mock).mockRejectedValue(new Error('invalid key SECRET'));
    send.mockClear();
    await expect(sendBoundedFirebase(a, { token: 'test' })).rejects.toMatchObject({ message: 'FCM_AUTH_FAILED' });
    expect(send).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
