import { withDeadline } from './with-deadline';

// Explicitly wrap the commands used by RedisService and its raw-client callers.
// Lifecycle/events remain bound to the real client (node-redis has private fields).
const COMMANDS = new Set([
  'get',
  'getDel',
  'set',
  'setEx',
  'del',
  'exists',
  'eval',
  'keys',
]);

export function withRedisCommandDeadlines<T extends object>(
  client: T,
  timeoutMs: number,
  onTimeout: () => void,
): T {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!methods.has(key)) {
        methods.set(
          key,
          COMMANDS.has(String(key))
            ? (...args: unknown[]) =>
                withDeadline(
                  () => value.apply(target, args),
                  timeoutMs,
                  onTimeout,
                )
            : value.bind(target),
        );
      }
      return methods.get(key);
    },
  });
}
