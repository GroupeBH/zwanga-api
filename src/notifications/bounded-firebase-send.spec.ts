import { createServer, type Server } from 'node:http';
import { sendBoundedFirebase, firebaseWireMessage } from './bounded-firebase-send';
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
  it('aborts a stalled response and makes no hidden retry', async () => {
    mode = 'slow'; const start = Date.now();
    await expect(sendBoundedFirebase(app(), { token: 'test' }, 150)).rejects.toThrow();
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
