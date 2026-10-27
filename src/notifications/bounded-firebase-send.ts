import type { App } from 'firebase-admin/app';
import type { Message } from 'firebase-admin/messaging';

// One OAuth refresh per app. A slow credential lookup never creates unbounded
// abandoned refreshes; the HTTP send itself is aborted and has no hidden retry.
const tokens = new WeakMap<App, { value?: string; until: number; pending?: Promise<string> }>();
async function accessToken(app: App): Promise<string> {
  let state = tokens.get(app);
  if (!state) { state = { until: 0 }; tokens.set(app, state); }
  if (state.value && state.until > Date.now() + 60000) return state.value;
  if (!state.pending) {
    const target = state;
    target.pending = Promise.resolve().then(async () => {
      const token = await app.options.credential!.getAccessToken();
      target.value = token.access_token;
      target.until = Date.now() + token.expires_in * 1000;
      return token.access_token;
    }).finally(() => { target.pending = undefined; });
  }
  return state.pending!;
}
function waitForToken(app: App, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('FCM_AUTH_TIMEOUT'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); return; }
    accessToken(app).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Public HTTP v1 wire format for the ride payloads built by this application. */
export function firebaseWireMessage(message: Message): Record<string, unknown> {
  const wire = structuredClone(message) as unknown as Record<string, any>;
  if (wire.android) {
    if (typeof wire.android.ttl === 'number') wire.android.ttl = `${(Math.max(0, wire.android.ttl) / 1000).toFixed(3)}s`;
    if (wire.android.priority) wire.android.priority = wire.android.priority.toUpperCase();
    const n = wire.android.notification;
    if (n) {
      if (n.channelId !== undefined) { n.channel_id = n.channelId; delete n.channelId; }
      if (n.visibility) n.visibility = n.visibility.toUpperCase();
    }
  }
  const aps = wire.apns?.payload?.aps;
  if (aps) for (const [from, to] of [['threadId', 'thread-id'], ['contentAvailable', 'content-available'], ['mutableContent', 'mutable-content']]) {
    if (aps[from] !== undefined) { aps[to] = typeof aps[from] === 'boolean' ? Number(aps[from]) : aps[from]; delete aps[from]; }
  }
  return wire;
}

export async function sendBoundedFirebase(app: App, message: Message, budgetMs = 8000): Promise<string> {
  const project = app.options.projectId;
  if (!project || !/^[a-zA-Z0-9:._-]+$/.test(project) || !app.options.credential) throw new Error('FCM_PROJECT_UNAVAILABLE');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(budgetMs, 8000)));
  try {
    const token = await waitForToken(app, controller.signal);
    controller.signal.throwIfAborted();
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: firebaseWireMessage(message) }), signal: controller.signal,
    });
    const result = await response.json() as { name?: string; error?: { status?: string; details?: { errorCode?: string }[] } };
    if (!response.ok || !result.name) {
      if (response.status === 401) tokens.delete(app);
      const unregistered = result.error?.details?.some(detail => detail.errorCode === 'UNREGISTERED');
      throw Object.assign(new Error(`FCM_HTTP_${response.status}`), {
        code: unregistered ? 'messaging/registration-token-not-registered' : `messaging/${result.error?.status ?? 'unknown'}`,
      });
    }
    return result.name;
  } finally { clearTimeout(timer); }
}
