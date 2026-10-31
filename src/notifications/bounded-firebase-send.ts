import type { App } from 'firebase-admin/app';
import type { Message } from 'firebase-admin/messaging';
import { FirebaseDeliveryError } from './firebase-delivery-error';

// FCM recommends a send timeout of at least 10 seconds. OAuth has its own
// budget so a cold credential refresh cannot consume the HTTP send window.
export const FCM_SEND_TIMEOUT_MS = 15_000;
export const FCM_AUTH_TIMEOUT_MS = 5_000;
const FCM_MAX_SEND_TIMEOUT_MS = 30_000;

// One OAuth refresh per app. A slow credential lookup never creates unbounded
// abandoned refreshes; the HTTP send itself is aborted and has no hidden retry.
const tokens = new WeakMap<
  App,
  { value?: string; until: number; pending?: Promise<string> }
>();
async function accessToken(app: App): Promise<string> {
  let state = tokens.get(app);
  if (!state) {
    state = { until: 0 };
    tokens.set(app, state);
  }
  if (state.value && state.until > Date.now() + 60000) return state.value;
  if (!state.pending) {
    const target = state;
    target.pending = Promise.resolve()
      .then(async () => {
        const token = await app.options.credential!.getAccessToken();
        target.value = token.access_token;
        target.until = Date.now() + token.expires_in * 1000;
        return token.access_token;
      })
      .finally(() => {
        target.pending = undefined;
      });
  }
  return state.pending!;
}
function waitForToken(app: App, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new FirebaseDeliveryError('FCM_AUTH_TIMEOUT', {
            code: 'messaging/auth-timeout',
            phase: 'auth',
            transient: true,
            timeoutMs,
          }),
        ),
      timeoutMs,
    );
    accessToken(app)
      .then(resolve, () =>
        reject(
          new FirebaseDeliveryError('FCM_AUTH_FAILED', {
            code: 'messaging/authentication-error',
            phase: 'auth',
            transient: false,
          }),
        ),
      )
      .finally(() => clearTimeout(timer));
  });
}

/** Public HTTP v1 wire format for the ride payloads built by this application. */
export function firebaseWireMessage(message: Message): Record<string, unknown> {
  const copy = structuredClone(message);
  const wire: Record<string, unknown> = { ...copy };
  if (copy.android) {
    const android: Record<string, unknown> = { ...copy.android };
    if (typeof copy.android.ttl === 'number')
      android.ttl = `${(Math.max(0, copy.android.ttl) / 1000).toFixed(3)}s`;
    if (copy.android.priority)
      android.priority = copy.android.priority.toUpperCase();
    if (copy.android.notification) {
      const notification: Record<string, unknown> = {
        ...copy.android.notification,
      };
      if (copy.android.notification.channelId !== undefined) {
        notification.channel_id = copy.android.notification.channelId;
        delete notification.channelId;
      }
      if (copy.android.notification.visibility)
        notification.visibility =
          copy.android.notification.visibility.toUpperCase();
      android.notification = notification;
    }
    wire.android = android;
  }
  if (copy.apns?.payload?.aps) {
    const aps: Record<string, unknown> = { ...copy.apns.payload.aps };
    for (const [from, to] of [
      ['threadId', 'thread-id'],
      ['contentAvailable', 'content-available'],
      ['mutableContent', 'mutable-content'],
    ]) {
      if (aps[from] !== undefined) {
        aps[to] =
          typeof aps[from] === 'boolean' ? Number(aps[from]) : aps[from];
        delete aps[from];
      }
    }
    wire.apns = { ...copy.apns, payload: { ...copy.apns.payload, aps } };
  }
  return wire;
}

export async function sendBoundedFirebase(
  app: App,
  message: Message,
  budgetMs = FCM_SEND_TIMEOUT_MS,
): Promise<string> {
  const project = app.options.projectId;
  if (
    !project ||
    !/^[a-zA-Z0-9:._-]+$/.test(project) ||
    !app.options.credential
  )
    throw new Error('FCM_PROJECT_UNAVAILABLE');
  const body = JSON.stringify({ message: firebaseWireMessage(message) });
  const timeoutMs = Number.isFinite(budgetMs)
    ? Math.max(1, Math.min(budgetMs, FCM_MAX_SEND_TIMEOUT_MS))
    : FCM_SEND_TIMEOUT_MS;
  const token = await waitForToken(
    app,
    Math.min(timeoutMs, FCM_AUTH_TIMEOUT_MS),
  );
  // Abort the actual request, not merely its caller. Outbox recovery is the
  // only retry owner; an aborted POST might already have been accepted by FCM.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${project}/messages:send`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body,
        signal: controller.signal,
      },
    );
    // Even an HTML/empty 401 must invalidate the cached access token.
    if (response.status === 401) tokens.delete(app);
    const result = (await response.json().catch(() => null)) as {
      name?: string;
      error?: { details?: { errorCode?: string }[] };
    } | null;
    if (controller.signal.aborted) throw new Error('aborted');
    if (!response.ok) {
      const unregistered =
        Array.isArray(result?.error?.details) &&
        result.error.details.some(
          (detail) => detail?.errorCode === 'UNREGISTERED',
        );
      throw new FirebaseDeliveryError(`FCM_HTTP_${response.status}`, {
        code: unregistered
          ? 'messaging/registration-token-not-registered'
          : 'messaging/provider-error',
        phase: 'send',
        transient: response.status === 429 || response.status >= 500,
        httpStatus: response.status,
      });
    }
    if (typeof result?.name !== 'string' || !result.name) {
      throw new FirebaseDeliveryError('FCM_INVALID_RESPONSE', {
        code: 'messaging/invalid-response',
        phase: 'send',
        transient: true,
        httpStatus: response.status,
      });
    }
    return result.name;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new FirebaseDeliveryError('FCM_SEND_TIMEOUT', {
        code: 'messaging/send-timeout',
        phase: 'send',
        transient: true,
        timeoutMs,
      });
    }
    if (error instanceof FirebaseDeliveryError) throw error;
    throw new FirebaseDeliveryError('FCM_NETWORK_ERROR', {
      code: 'messaging/network-error',
      phase: 'send',
      transient: true,
    });
  } finally {
    clearTimeout(timer);
  }
}
