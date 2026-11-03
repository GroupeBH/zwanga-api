import type { App } from 'firebase-admin/app';
import { FCM_AUTH_TIMEOUT_MS, prewarmFirebaseAccessToken, sendBoundedFirebase } from './bounded-firebase-send';
import { NotificationService } from './notifications.service';

describe('Firebase credential prewarm (synthetic credentials, no provider)', () => {
  const fixture = () => {
    const getAccessToken = jest.fn().mockResolvedValue({ access_token: 'synthetic', expires_in: 3600 });
    const app = { options: { projectId: 'local-only', credential: { getAccessToken } } } as unknown as App;
    const send = jest.spyOn(global, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ name: 'local/receipt' }), { status: 200 }));
    return { app, getAccessToken, send };
  };
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it('warms once, sends no message, and lets the first burst reuse the cached token', async () => {
    const f = fixture();
    await prewarmFirebaseAccessToken(f.app);
    expect(f.send).not.toHaveBeenCalled();
    await Promise.all(Array.from({ length: 8 }, () => sendBoundedFirebase(f.app, { token: 'test-device' })));
    expect(f.getAccessToken).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(8);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('shares a refresh already in flight with the first send', async () => {
    const f = fixture();
    let release!: (value: { access_token: string; expires_in: number }) => void;
    f.getAccessToken.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const warm = prewarmFirebaseAccessToken(f.app);
    const sending = sendBoundedFirebase(f.app, { token: 'test-device' });
    await jest.advanceTimersByTimeAsync(1);
    expect(f.getAccessToken).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    release({ access_token: 'synthetic', expires_in: 3600 });
    await Promise.all([warm, sending]);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refreshes before expiration, not at every periodic prewarm', async () => {
    const f = fixture();
    await prewarmFirebaseAccessToken(f.app);
    await jest.advanceTimersByTimeAsync(30_000);
    await prewarmFirebaseAccessToken(f.app);
    expect(f.getAccessToken).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3_510_000);
    await prewarmFirebaseAccessToken(f.app);
    expect(f.getAccessToken).toHaveBeenCalledTimes(2);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('allows delivery to retry authentication after a failed prewarm', async () => {
    const f = fixture(); f.getAccessToken.mockRejectedValueOnce(new Error('synthetic secret must not leak'));
    await expect(prewarmFirebaseAccessToken(f.app)).rejects.toThrow('FCM_AUTH_FAILED');
    await expect(sendBoundedFirebase(f.app, { token: 'test-device' })).resolves.toBe('local/receipt');
    expect(f.getAccessToken).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled credential and leaves no send or timer after timeout', async () => {
    const f = fixture(); f.getAccessToken.mockReturnValue(new Promise(() => {}));
    const result = expect(prewarmFirebaseAccessToken(f.app)).rejects.toThrow('FCM_AUTH_TIMEOUT');
    await jest.advanceTimersByTimeAsync(FCM_AUTH_TIMEOUT_MS); await result;
    expect(f.send).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('skips missing credentials/shutdown, coalesces cron invocations and absorbs failures', async () => {
    const f = fixture();
    const service = new NotificationService({} as any, {} as any, {} as any, {} as any);
    const warning = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    await service.prewarmFirebase(); expect(f.getAccessToken).not.toHaveBeenCalled();
    (service as any).firebaseApp = f.app;
    f.getAccessToken.mockRejectedValueOnce(new Error('synthetic secret must not leak'));
    await Promise.all([service.prewarmFirebase(), service.prewarmFirebase()]);
    expect(f.getAccessToken).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).not.toContain('synthetic secret');
    service.onModuleDestroy();
    await service.prewarmFirebase();
    expect(f.getAccessToken).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
  });
});
