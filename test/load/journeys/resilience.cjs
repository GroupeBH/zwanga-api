'use strict';
const { performance } = require('node:perf_hooks');
const { replicaFor } = require('./scenario-inputs.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function exerciseRecovery(resources, clients, rows, p) {
  if (!p.resilience) throw new Error('Explicit resilience profile required');
  const evidence = [], before = await resources.metrics();
  if (before.queue.pending < 1) throw new Error('Fault scenario requires committed pending jobs');
  // Drain in-flight generator operations before this distinct fault window. A
  // killed worker can still hold a durable lease: allow its real 90s TTL to expire.
  for (const c of clients) c.close();
  const started = performance.now();
  await resources.restartBackend(0);
  await resources.interruptRedis(1500);
  let sample;
  const deadline = performance.now() + 120000;
  do {
    sample = await resources.metrics();
    if (sample.servers.every(s => s.redisReady) && sample.queue.pending === 0) break;
    if (performance.now() > deadline) throw new Error('Fault recovery deadline');
    await pause(1000);
  } while (true);
  evidence.push({ kind: 'backend-crash-and-redis-disconnect', milliseconds: performance.now() - started,
    before, after: sample, queueDrained: true });
  await resources.pauseProgress(false);
  const reconnectAt = performance.now();
  // Bounded storm: batches of 16 rather than an unbounded Promise.all.
  for (let i = 0; i < clients.length; i += 16) await Promise.all(clients.slice(i, i + 16).map(c => c.reconnect()));
  for (const client of clients) await resources.waitSocket(resources.origins.indexOf(client.origin), client.namespace, client.socket.id);
  for (const [i, row] of rows.entries()) {
    for (const [socket, replica] of [[row.driverSocket, replicaFor(i, p)], [row.passengerSocket, replicaFor(i + 1, p)]]) {
      await resources.waitSocket(replica, '/tracking', socket.id);
      socket.emit('join_trip', { tripId: row.tripId });
      await resources.waitSocket(replica, '/tracking', socket.id, `trip:${row.tripId}`);
    }
    row.next = performance.now() + i * p.gpsIntervalMs / rows.length;
  }
  evidence.push({ kind: 'bounded-reconnection-storm', clients: clients.length, milliseconds: performance.now() - reconnectAt });
  return evidence;
}
module.exports = { exerciseRecovery };
