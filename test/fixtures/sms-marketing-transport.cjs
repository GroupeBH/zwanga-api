'use strict';
// Owned loopback HTTPS origin + CONNECT proxy only. No .env or cloud service.
const assert = require('node:assert/strict');
const { context, trace, SpanKind } = require('@opentelemetry/api');
const {
  AsyncLocalStorageContextManager,
} = require('@opentelemetry/context-async-hooks');
const {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} = require('@opentelemetry/sdk-trace-base');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
trace.setGlobalTracerProvider(provider);
const instrument = new HttpInstrumentation({
  disableIncomingRequestInstrumentation: true,
});
instrument.setTracerProvider(provider);
instrument.enable();
require('ts-node/register/transpile-only');
const http = require('node:http');
const https = require('node:https');
const { connect } = require('node:net');
const { once } = require('node:events');
const { ConfigService } = require('@nestjs/config');
const { HttpService } = require('@nestjs/axios');
const { Logger } = require('@nestjs/common');
const axios = require('axios');
const { certificate, privateKey } = require('./mobishastra-test-tls');
const { SmsMarketingConfig } = require('../../src/sms-marketing/sms.config');
const {
  MobishastraMarketingTransport,
} = require('../../src/sms-marketing/mobishastra-marketing.transport');
const logs = [];
Logger.overrideLogger({
  log: (...x) => logs.push(x),
  warn: (...x) => logs.push(x),
  error: (...x) => logs.push(x),
  debug: (...x) => logs.push(x),
  verbose: (...x) => logs.push(x),
});
const sockets = new Set();
let reply = '000 - Send Successful',
  reached = 0;
const origins = [];
const origin = https.createServer(
  { key: privateKey, cert: certificate },
  (req, res) => {
    reached++;
    origins.push(performance.now());
    const u = new URL(req.url, 'https://mshastra.com');
    assert.equal(u.pathname, '/sendurl.aspx');
    assert.equal(u.searchParams.get('senderid'), 'PROMOTEST');
    res.end(reply);
  },
);
const proxy = http.createServer((_req, res) => res.end('baseline'));
for (const server of [origin, proxy])
  server.on('connection', (s) => sockets.add(s));
proxy.on('connect', (req, downstream, head) => {
  assert.equal(req.url, 'mshastra.com:443');
  const upstream = connect(origin.address().port, '127.0.0.1');
  sockets.add(upstream);
  upstream.on('error', () => downstream.destroy());
  downstream.on('error', () => upstream.destroy());
  downstream.on('close', () => upstream.destroy());
  upstream.on('connect', () => {
    downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    downstream.pipe(upstream).pipe(downstream);
  });
});
let service;
async function main() {
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const client = axios.create();
  client.interceptors.request.use((c) => {
    c.httpsAgent.options.ca = certificate;
    return c;
  });
  service = new MobishastraMarketingTransport(
    new SmsMarketingConfig(
      new ConfigService({
        NODE_ENV: 'test',
        SMS_MARKETING_PROVIDER_CONFIRMED: 'true',
        SMS_MARKETING_SENDER_ID: 'PROMOTEST',
        SMS_MARKETING_LINK_HOST: 'z.test',
        SMS_MARKETING_OPT_OUT_BASE_URL: 'https://z.test/s/',
        MOBISHASTRA_PROFILE_ID: 'synthetic-profile',
        MOBISHASTRA_PASSWORD: 'synthetic-password',
        MOBISHASTRA_PROXY_URL: `http://127.0.0.1:${proxy.address().port}`,
      }),
    ),
    new HttpService(client),
  );
  const start = performance.now();
  for (let i = 0; i < 6; i++) {
    assert.deepEqual(
      await service.send(
        '+243900000001',
        'Synthetic promotion Stop SMS: https://z.test/s/Ab3dE9xK',
      ),
      { accepted: true },
    );
    if (i < 5) await new Promise((r) => setTimeout(r, 500));
  }
  const duration = performance.now() - start;
  reply = '005 - synthetic-password +243900000001 Synthetic promotion';
  assert.deepEqual(await service.send('+243900000001', 'Synthetic promotion'), {
    accepted: false,
    code: 'PROVIDER_NOT_CONFIRMED',
  });
  assert.equal(reached, 7);
  await provider.forceFlush();
  assert.equal(exporter.getFinishedSpans().length, 0);
  assert(
    !/synthetic-password|243900000001|Synthetic promotion/.test(
      JSON.stringify(logs),
    ),
  );
  await new Promise((resolve, reject) =>
    http
      .get(`http://127.0.0.1:${proxy.address().port}/after`, (r) => {
        r.resume();
        r.on('end', resolve);
      })
      .on('error', reject),
  );
  await provider.forceFlush();
  assert(exporter.getFinishedSpans().some((s) => s.kind === SpanKind.CLIENT));
  console.log(
    JSON.stringify({
      simulatedSubmissions: 6,
      durationMs: Math.round(duration),
      pacedRatePerSecond: Number(
        (5 / ((origins[5] - origins[0]) / 1000)).toFixed(2),
      ),
      sensitiveSpans: 0,
    }),
  );
}
main()
  .catch(() => {
    console.error('SMS_LOOPBACK_TEST_FAILED');
    process.exitCode = 1;
  })
  .finally(async () => {
    service?.onModuleDestroy();
    for (const s of sockets) s.destroy();
    await Promise.all(
      [origin, proxy].map((s) => new Promise((r) => s.close(r))),
    );
    instrument.disable();
    await provider.shutdown();
    context.disable();
    trace.disable();
    manager.disable();
  });
