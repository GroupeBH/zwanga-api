import { EventEmitter } from 'node:events';
import { Server } from 'socket.io';
import { createResilientRedisAdapter, redisBroadcastReady } from './resilient-redis.adapter';
import { RideAlertRealtime } from '../notifications/ride-alert-realtime.service';

class TestRedis extends EventEmitter {
  #ready = true;
  get isReady() { return this.#ready; }
  setReady(ready: boolean) { this.#ready = ready; }
  publish = jest.fn<Promise<number>, unknown[]>().mockResolvedValue(1);
  pSubscribe = jest.fn().mockResolvedValue(undefined);
  subscribe = jest.fn().mockResolvedValue(undefined);
  pUnsubscribe = jest.fn().mockResolvedValue(undefined);
  unsubscribe = jest.fn().mockResolvedValue(undefined);
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const pub = new TestRedis(), sub = new TestRedis(), failed = jest.fn();
  const io = new Server();
  io.adapter(createResilientRedisAdapter(pub, sub, failed));
  const namespace = io.of('/chat');
  return { pub, sub, failed, io, namespace, adapter: namespace.adapter as any };
}

describe('Redis adapter outage handling', () => {
  it('observes the actual adapter broadcast rejection without changing local routing or escaping the original rejected promise', async () => {
    const f = fixture(), offline = new Error('offline');
    const rejection = Promise.reject(offline);
    f.pub.publish.mockReturnValue(rejection);
    // Socket.IO does not return/await publish. With the raw adapter this causes
    // an unhandled rejection and terminates the real API under Winston.
    f.namespace.to('user:driver').emit('ride_alert', { eventId: 'event' });
    await flush();
    expect(f.failed).toHaveBeenCalledWith('pub', 'publish');
    expect(f.pub.publish.mock.calls[0][0]).toContain('#user:driver#');
    expect(f.adapter.pubClient.publish('channel', 'value')).toBe(rejection);
    await expect(rejection).rejects.toBe(offline);
    f.adapter.close();
  });

  it('handles synchronous publication failure without creating an unhandled rejection', async () => {
    const f = fixture(); f.pub.publish.mockImplementation(() => { throw new Error('closed'); });
    expect(() => f.namespace.to('user:driver').emit('ride_alert', {})).not.toThrow();
    await flush(); expect(f.failed).toHaveBeenCalledWith('pub', 'publish'); f.adapter.close();
  });

  it('observes discarded subscription/unsubscription rejections, including shutdown during a disconnect', async () => {
    const pub = new TestRedis(), sub = new TestRedis(), failed = jest.fn(), io = new Server();
    for (const operation of ['pSubscribe', 'subscribe', 'pUnsubscribe', 'unsubscribe'] as const)
      sub[operation].mockRejectedValue(new Error('offline'));
    const adapter = createResilientRedisAdapter(pub, sub, failed)(io.of('/tracking'));
    adapter.close(); await flush();
    for (const operation of ['pSubscribe', 'subscribe', 'pUnsubscribe', 'unsubscribe'])
      expect(failed).toHaveBeenCalledWith('sub', operation);
  });

  it('does not publish local-only broadcasts or break Redis private fields / method receivers', async () => {
    const f = fixture();
    expect(redisBroadcastReady(f.adapter)).toBe(true);
    f.adapter.pubClient.setReady(false);
    expect(f.pub.isReady).toBe(false);
    expect(redisBroadcastReady(f.adapter)).toBe(false);
    f.namespace.local.to('user:driver').emit('ride_alert', {});
    await flush(); expect(f.pub.publish).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled(); f.adapter.close();
  });

  it('leaves the realtime outbox retryable for a known outage and resumes the same authorized user room', async () => {
    const f = fixture(), hints = new RideAlertRealtime(); hints.bind(f.namespace as any);
    for (const client of [f.pub, f.sub]) {
      client.setReady(false);
      expect(hints.publish('driver', { eventId: 'event' })).toBe(false);
      expect(f.pub.publish).not.toHaveBeenCalled(); client.setReady(true);
    }
    expect(hints.publish('driver', { eventId: 'event' })).toBe(true);
    expect(f.pub.publish.mock.calls[0][0]).toContain('#user:driver#');
    expect(hints.publish('', {})).toBe(false);
    f.adapter.close();
  });

  it('never creates another rejected promise when diagnostics themselves throw', async () => {
    const pub = new TestRedis(), sub = new TestRedis(), io = new Server();
    const adapter = createResilientRedisAdapter(pub, sub, () => { throw new Error('logger closed'); })(io.of('/tracking'));
    pub.publish.mockRejectedValue(new Error('offline'));
    adapter.broadcast({ type: 2, data: ['position', {}] }, { rooms: new Set(['trip:x']), except: new Set(), flags: {} });
    await flush(); adapter.close();
  });
});
