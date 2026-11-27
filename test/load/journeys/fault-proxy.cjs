'use strict';
const net = require('node:net');

/** Private relay to a parent-owned, freshly provisioned Redis. No arbitrary target. */
async function redisFaultProxy(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid disposable Redis port');
  const sockets = new Set(); let interrupted = false;
  const server = net.createServer(client => {
    if (interrupted) { client.destroy(); return; }
    const upstream = net.connect(port, '127.0.0.1');
    for (const s of [client, upstream]) {
      sockets.add(s); s.on('error', () => { client.destroy(); upstream.destroy(); });
      s.on('close', () => { sockets.delete(s); client.destroy(); upstream.destroy(); });
    }
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port,
    interrupt() { interrupted = true; for (const s of sockets) s.destroy(); },
    restore() { interrupted = false; },
    async close() { interrupted = true; for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
module.exports = { redisFaultProxy };
