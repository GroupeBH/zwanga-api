import { createAdapter, RedisAdapter } from '@socket.io/redis-adapter';
import type { RedisAdapterOptions } from '@socket.io/redis-adapter';

type RedisClient = { readonly isReady: boolean } & object;
type RedisOperation = 'publish' | 'subscribe' | 'pSubscribe' | 'unsubscribe' | 'pUnsubscribe';
type FailureObserver = (client: 'pub' | 'sub', operation: RedisOperation) => void;
const observedOperations = new Set<string>([
  'publish', 'subscribe', 'pSubscribe', 'unsubscribe', 'pUnsubscribe',
]);

/** The upstream adapter intentionally discards these node-redis promises.
 * Observe rejections without converting the original promise into a success:
 * awaiting callers must still receive its rejection. No payloads/credentials
 * are sent to the observer, and Redis' bounded/offline policy is unchanged. */
function observeClient<T extends RedisClient>(client: T, role: 'pub' | 'sub', onFailure: FailureObserver): T {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(client, {
    get(target, key) {
      // node-redis getters and methods use private fields: always use the real receiver.
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (methods.has(key)) return methods.get(key);
      const bound = value.bind(target);
      const method = !observedOperations.has(String(key)) ? bound : (...args: unknown[]) => {
        let result: unknown;
        try { result = bound(...args); }
        catch (error) { result = Promise.reject(error); }
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          // Keep this handler synchronous/non-throwing; otherwise its own ignored
          // promise could recreate the unhandled rejection we are preventing.
          void Promise.resolve(result).catch(() => {
            try { onFailure(role, key as RedisOperation); } catch { /* diagnostic observer only */ }
          });
        }
        return result;
      };
      methods.set(key, method);
      return method;
    },
  });
}

/** Same routing, protocol, subscriptions and authorization as the Redis adapter.
 * A publish accepted by Redis is NOT a delivery receipt; durable state and client
 * receipts/reconciliation remain necessary after disconnects. */
export function createResilientRedisAdapter(
  pubClient: RedisClient, subClient: RedisClient,
  onFailure: FailureObserver, options?: Partial<RedisAdapterOptions>,
): ReturnType<typeof createAdapter> {
  return createAdapter(observeClient(pubClient, 'pub', onFailure), observeClient(subClient, 'sub', onFailure), options);
}

/** Prevent marking a notification's realtime outbox entry complete when Redis
 * is already known to be offline. This check cannot guarantee delivery across
 * a subsequent disconnect; it must not replace application receipts. */
export function redisBroadcastReady(adapter: unknown): boolean {
  return !(adapter instanceof RedisAdapter) ||
    (adapter.pubClient.isReady === true && adapter.subClient.isReady === true);
}
