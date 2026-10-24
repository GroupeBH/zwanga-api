// Offline audit only. A synthetic webhook/key proves timestamp binding behavior.
const path = require('node:path');
const { createHmac } = require('node:crypto');
require('ts-node').register({ project: path.join(__dirname, '../../tsconfig.json'), transpileOnly: true });
const { DiditKycService } = require('../../src/users/didit-kyc.service');
const secret = 'synthetic-replay-fixture-not-a-real-webhook-secret';
const now = String(Math.floor(Date.now() / 1000));
const old = String(Number(now) - 86400);
const body = { session_id: 'synthetic-session', status: 'Approved', timestamp: old, webhook_type: 'status.updated' };
const canonical = JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))));
const sign = (value) => createHmac('sha256', secret).update(value).digest('hex');
const signatures = { 'x-signature-v2': sign(canonical),
  'x-signature-simple': sign(`${old}:${body.session_id}:${body.status}:${body.webhook_type}`) };
const service = new DiditKycService(null, null,
  { get: (key) => key === 'DIDIT_WEBHOOK_SECRET' ? secret : undefined }, null);
let reproduced = 0;
for (const [variant, signature] of Object.entries(signatures)) {
  for (const headerTimestamp of [old, now]) {
    let accepted = false;
    try { service.verifyWebhookSignature({ [variant]: signature, 'x-timestamp': headerTimestamp }, body); accepted = true; }
    catch (error) { if (error.getStatus?.() !== 401) throw error; }
    console.log(JSON.stringify({ variant, signedPayloadAgeSeconds: 86400,
      headerRefreshed: headerTimestamp === now, accepted, realProviderCalls: 0 }));
    if (accepted) reproduced++;
  }
}
console.log(JSON.stringify({ finding: 'DIDIT_UNSIGNED_HEADER_REPLAY', reproducedCases: reproduced,
  prerequisite: 'attacker already possesses an authentic signed delivery; fixture uses a synthetic key' }));
if (reproduced) process.exitCode = 1;
