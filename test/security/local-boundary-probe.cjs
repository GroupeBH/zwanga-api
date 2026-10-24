/* Local-only, bounded, unauthenticated security checks. No .env, account,
 * provider call, payment, OTP, upload, database mutation or load generation.
 * Run: node test/security/local-boundary-probe.cjs [local-port]
 * Output deliberately excludes response bodies, credentials and user data.
 */
const http = require('node:http');
const { createHmac } = require('node:crypto');

const port = Number(process.argv[2] || 5200);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Expected a local non-privileged port.');
}
const hostname = '127.0.0.1'; // Never accept an external destination.
const prefix = '/api/v1';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const encode = (data) => Buffer.from(JSON.stringify(data)).toString('base64url');
const payload = encode({ sub: '00000000-0000-4000-8000-000000000001', role: 'super_admin', exp: Math.floor(Date.now() / 1000) + 60 });
const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${payload}.`;
const signingInput = `${encode({ alg: 'HS256', typ: 'JWT' })}.${payload}`;
const wrongSignature = `${signingInput}.${createHmac('sha256', 'synthetic-test-key-never-a-real-secret').update(signingInput).digest('base64url')}`;

function probe({ id, path, method = 'GET', headers = {}, body, expected }) {
  return new Promise((resolve) => {
    const started = performance.now();
    const timer = setTimeout(() => req.destroy(new Error('deadline')), 5000);
    const req = http.request({ hostname, port, path, method, agent: false,
      headers: { 'User-Agent': 'Zwanga-local-security-audit/2026-10-24', ...headers,
        ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }) } }, (res) => {
      let bytes = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) req.destroy(new Error('response-limit'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString();
        resolve({ id, method, path, status: res.statusCode,
          outcome: expected ? (expected.includes(res.statusCode) ? 'pass' : 'unexpected') : 'observation',
          bytes, durationMs: Math.round(performance.now() - started),
          stackExposed: /\bat (?:async )?\S+.*(?:\.ts|\.js):\d+:\d+/.test(text),
          headers: { poweredBy: res.headers['x-powered-by'] || null,
            nosniff: res.headers['x-content-type-options'] || null,
            cacheControl: res.headers['cache-control'] || null,
            cspPresent: !!res.headers['content-security-policy'],
            allowsSyntheticOrigin: res.headers['access-control-allow-origin'] === 'https://audit.example.invalid' } });
      });
      res.on('error', () => req.destroy(new Error('response-error')));
    });
    req.on('error', () => { clearTimeout(timer); resolve({ id, method, path, outcome: 'inconclusive', error: 'connection_failed_or_deadline' }); });
    req.end(body);
  });
}

function socketProbe(namespace, token) {
  return new Promise((resolve) => {
    let done = false;
    let connected = false;
    let rejected = false;
    let exposedData = false;
    const ws = new WebSocket(`ws://${hostname}:${port}/socket.io/?EIO=4&transport=websocket`);
    const finish = (closed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.close();
      resolve({ id: `ws-${namespace.slice(1)}-${token ? 'forged-jwt' : 'anonymous'}`,
        outcome: exposedData ? 'unexpected' : (rejected || (closed && connected) ? 'pass' : 'inconclusive'),
        namespace, rejected, disconnected: closed, exposedData });
    };
    const timer = setTimeout(() => finish(false), 4000);
    ws.addEventListener('message', ({ data }) => {
      const frame = String(data);
      if (frame === '2') { ws.send('3'); return; }
      if (frame.startsWith('0')) {
        connected = true;
        ws.send(`40${namespace},${JSON.stringify(token ? { token } : {})}`);
      }
      if (frame.startsWith(`44${namespace},`) || frame.startsWith(`41${namespace}`)) {
        rejected = true;
        finish(true);
      }
      if (frame.startsWith(`42${namespace},`)) {
        try {
          const event = JSON.parse(frame.slice(frame.indexOf(',') + 1))[0];
          if (['messages', 'new_message', 'driver_location', 'passenger_location', 'trip_location_update'].includes(event)) exposedData = true;
          if (['error', 'session_expired'].includes(event)) rejected = true;
        } catch { /* Retain neither raw frames nor personal data. */ }
      }
    });
    ws.addEventListener('close', () => finish(true));
    ws.addEventListener('error', () => finish(false));
  });
}

async function main() {
  const results = [];
  const cases = [
    { id: 'liveness-before', path: '/health/live', expected: [200] },
    ...['users/me', 'admin/users', 'admin/accounts', 'admin/kyc', 'wallet/me', 'referrals/me', 'driver-settlements/me', 'payments/history', 'notifications'].map((route) => ({ id: `anonymous-${route}`, path: `${prefix}/${route}`, expected: [401] })),
    { id: 'malformed-bearer', path: `${prefix}/users/me`, headers: { Authorization: 'Bearer not-a-jwt' }, expected: [401] },
    { id: 'jwt-none', path: `${prefix}/admin/users`, headers: { Authorization: `Bearer ${unsigned}` }, expected: [401] },
    { id: 'jwt-wrong-signature', path: `${prefix}/admin/accounts`, headers: { Authorization: `Bearer ${wrongSignature}` }, expected: [401] },
    { id: 'identity-header-spoof', path: `${prefix}/admin/users`, headers: { 'X-User-Id': '00000000-0000-4000-8000-000000000001', 'X-User-Role': 'super_admin', 'X-Forwarded-For': '127.0.0.1' }, expected: [401] },
    { id: 'query-role-spoof', path: `${prefix}/admin/users?role=super_admin&isAdmin=true`, expected: [401] },
    { id: 'private-head', method: 'HEAD', path: `${prefix}/wallet/me`, expected: [401] },
    { id: 'dot-env-not-served', path: '/.env', expected: [401, 404] },
    { id: 'git-config-not-served', path: '/.git/config', expected: [401, 404] },
    { id: 'encoded-traversal-not-served', path: '/uploads/%2e%2e/%2e%2e/.env', expected: [401, 404] },
    // Deliberately unknown route: exercise parsers without reaching a business handler.
    { id: 'malformed-json', method: 'POST', path: '/__zwanga_security_probe_no_route__', headers: { 'Content-Type': 'application/json' }, body: '{', expected: [400] },
    { id: 'bounded-body-limit', method: 'POST', path: '/__zwanga_security_probe_no_route__', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sample: 'a'.repeat(130 * 1024) }), expected: [413] },
    { id: 'cors-development-observation', method: 'OPTIONS', path: `${prefix}/users/me`, headers: { Origin: 'https://audit.example.invalid', 'Access-Control-Request-Method': 'GET' } },
    { id: 'swagger-exposure-observation', path: `${prefix}/docs-json` },
  ];
  for (const test of cases) {
    const result = await probe(test);
    results.push(result);
    console.log(JSON.stringify(result));
    if (test.id === 'liveness-before' && result.status !== 200) throw new Error('Local server not ready; stopping.');
    if (result.status >= 500 || result.outcome === 'inconclusive') {
      process.exitCode = 1;
      return; // Do not continue with socket checks against an unhealthy server.
    }
    await delay(200);
  }
  for (const namespace of ['/chat', '/tracking']) {
    for (const token of [undefined, wrongSignature]) {
      const result = await socketProbe(namespace, token);
      results.push(result);
      console.log(JSON.stringify(result));
      await delay(200);
    }
  }
  const after = await probe({ id: 'liveness-after', path: '/health/live', expected: [200] });
  results.push(after);
  console.log(JSON.stringify(after));
  const counts = results.reduce((summary, item) => { summary[item.outcome] = (summary[item.outcome] || 0) + 1; return summary; }, {});
  console.log(JSON.stringify({ total: results.length, counts }));
  if (counts.unexpected || counts.inconclusive) process.exitCode = 1;
}
main().catch(() => { console.error('Local probe stopped; no detailed response data retained.'); process.exitCode = 1; });
