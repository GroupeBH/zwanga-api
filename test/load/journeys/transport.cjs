'use strict';
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { io } = require('socket.io-client');
const { loopbackOrigin } = require('./profile.cjs');

function createHttpAgent() {
  // Node 24 only clamps the server's keep-alive hint against a positive agent
  // timeout. Retire idle connections before the server, without retrying writes
  // or changing the independent five-second request deadline/admission budget.
  return new http.Agent({ keepAlive: true, maxSockets: 32, timeout: 5000 });
}
function httpClient(origins) {
  const allowed = new Set(origins.map(loopbackOrigin));
  const agent = createHttpAgent();
  return { close: () => agent.destroy(), request: (origin, path, token, body, method = body ? 'POST' : 'GET', expectedConflict = false) => new Promise((resolve, reject) => {
    const permitted = (method === 'POST' && (path === '/api/v1/trip-requests' ||
      /^\/api\/v1\/driver-dispatch\/notifications\/[a-f0-9-]{36}\/received$/.test(path))) ||
      (method === 'PUT' && (['/api/v1/driver-dispatch/position', '/api/v1/driver-dispatch/presence'].includes(path) ||
        /^\/api\/v1\/driver-dispatch\/offers\/[a-f0-9-]{36}\/respond$/.test(path))) ||
      (method === 'DELETE' && /^\/api\/v1\/trip-requests\/[a-f0-9-]{36}$/.test(path));
    if (expectedConflict && !(method === 'PUT' && path.endsWith('/respond')))
      return reject(new Error('Expected conflict only allowed for competing dispatch responses'));
    if (!allowed.has(origin) || !permitted)
      return reject(new Error('HTTP operation outside journey allowlist'));
    const start = performance.now(), payload = body ? JSON.stringify(body) : null;
    let deadline = false;
    const req = http.request(new URL(path, origin), { method, agent,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      let bytes = 0; const chunks = [];
      res.on('data', b => { bytes += b.length; if (bytes > 1024 * 1024) req.destroy(new Error('HTTP body too large')); else chunks.push(b); });
      res.on('aborted', () => { clearTimeout(timer); reject(new Error('HTTP response aborted')); });
      res.on('error', () => { clearTimeout(timer); reject(new Error('HTTP response error')); });
      res.on('end', () => { clearTimeout(timer); let result;
        try { result = bytes ? JSON.parse(Buffer.concat(chunks).toString()) : null; } catch { return reject(new Error('Invalid HTTP JSON')); }
        if ((res.statusCode < 200 || res.statusCode >= 300) && !(expectedConflict && res.statusCode === 409))
          return reject(new Error(`HTTP rejected ${res.statusCode}`));
        resolve({ body: result, status: res.statusCode, ms: performance.now() - start });
      });
    });
    const timer = setTimeout(() => { deadline = true; req.destroy(new Error('HTTP deadline')); }, 5000);
    req.on('error', error => { clearTimeout(timer);
      reject(new Error(`HTTP transport failed: ${httpErrorCategory(error, req, deadline)}`)); });
    req.end(payload);
  }) };
}

function httpErrorCategory(error, req, deadline) {
  const code = deadline ? 'deadline' : ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ERR_SOCKET_CLOSED'].includes(error?.code)
    ? error.code : 'unknown';
  return `${code}; reused=${req.reusedSocket === true}; finished=${req.writableFinished === true}`;
}

async function connect(origin, namespace, token, onFailure) {
  loopbackOrigin(origin);
  if (!['/tracking', '/chat'].includes(namespace)) throw new Error('Namespace not allowlisted');
  const socket = io(`${origin}${namespace}`, { auth: { token }, forceNew: true,
    reconnection: false, transports: ['websocket'], timeout: 5000, autoConnect: false });
  let closing = false;
  socket.on('error', value => onFailure(new Error(`Socket business error: ${socketErrorCategory(value)}`)));
  socket.on('session_expired', () => onFailure(new Error('Socket session expired')));
  socket.on('server_restart', () => onFailure(new Error('Server restart during load')));
  socket.on('disconnect', () => { if (!closing) onFailure(new Error('Unexpected socket disconnect')); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { closing = true; socket.disconnect(); reject(new Error('Socket connect deadline')); }, 6000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', () => { clearTimeout(timer); closing = true; socket.disconnect(); reject(new Error('Socket connect rejected')); });
    socket.connect();
  });
  return { socket, origin, namespace, close() { closing = true; socket.disconnect(); },
    async reconnect() {
      if (socket.connected) throw new Error('Reconnect requires intentional disconnect first');
      await new Promise((resolve, reject) => {
        const done = (error) => { clearTimeout(timer); socket.off('connect', ok); socket.off('connect_error', bad); error ? reject(error) : resolve(); };
        const ok = () => { closing = false; done(); }, bad = () => done(new Error('Reconnect rejected'));
        const timer = setTimeout(() => { socket.disconnect(); done(new Error('Reconnect deadline')); }, 10000);
        socket.once('connect', ok); socket.once('connect_error', bad); socket.connect();
      });
    } };
}
async function gps(socket, event, payload, timeoutMs) {
  if (!['driver_location_update', 'passenger_location_update'].includes(event)) throw new Error('GPS event not allowlisted');
  const started = performance.now();
  const ack = await socket.timeout(timeoutMs).emitWithAck(event, payload);
  if (ack?.success === false && ack.status === 'state_changed' && ack.code === 'TRACKING_STATE_CHANGED' &&
      ack.tripId === payload.tripId && ack.bookingId === payload.bookingId && ack.recordedAt === payload.recordedAt) {
    await require('./recovery.cjs').recoverTrackingState(socket, payload, timeoutMs);
    return { terminal: true, ms: performance.now() - started };
  }
  if (ack?.success !== true || ack.status !== 'accepted' || ack.recordedAt !== payload.recordedAt ||
      ack.tripId !== payload.tripId || (payload.bookingId && ack.bookingId !== payload.bookingId))
    throw new Error('GPS acknowledgement rejected or mismatched: ' + gpsAcknowledgementCategory(ack, payload));
  return performance.now() - started;
}
function gpsAcknowledgementCategory(ack, payload) {
  // Diagnose a refused sample without copying coordinates, identifiers, tokens
  // or arbitrary server messages. These categories never relax the acceptance gate.
  if (!ack || typeof ack !== 'object') return 'missing_reply';
  if (ack.tripId !== payload.tripId || ack.recordedAt !== payload.recordedAt ||
      (payload.bookingId && ack.bookingId !== payload.bookingId)) return 'correlation_mismatch';
  if (ack.status === 'superseded') return 'superseded';
  if (ack.status === 'state_changed') return 'state_changed';
  return ack.success === false ? 'rejected' : 'unknown_status';
}
function socketErrorCategory(value) {
  // No arbitrary message, user data or token is ever copied into the report.
  const known = new Map([
    ['Authentification requise.', 'authentication_not_registered'],
    ['Session expirée. Veuillez vous reconnecter.', 'session_expired'],
    ['Données WebSocket invalides.', 'invalid_websocket_data'],
    ['Une opération est déjà en cours. Réessayez dans un instant.', 'inflight_quota'],
    ['Trop de demandes. Réessayez dans un instant.', 'event_rate_quota'],
    ['Le trajet n’est plus en cours, le suivi en temps réel est arrêté', 'trip_not_active'],
    ['Le trajet doit être actif pour partager la position', 'trip_not_active'],
    ['Seules les réservations acceptées ou récupérables peuvent partager leur position', 'booking_not_trackable'],
    ['Impossible de traiter cette demande.', 'server_or_unknown'],
  ]);
  return known.get(value?.message) || 'unclassified';
}
module.exports = { httpClient, connect, gps, socketErrorCategory, httpErrorCategory, createHttpAgent };
