'use strict';
// Same preloader as ECS, but no exporter, detectors, credentials or cloud traffic.
const assert = require('node:assert/strict');
const {
  instrumentations,
} = require('@aws/aws-distro-opentelemetry-node-autoinstrumentation/register');
const {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} = require('@opentelemetry/sdk-trace-base');
const { SpanKind } = require('@opentelemetry/api');
const instrument = instrumentations.find(
  (i) => i.instrumentationName === '@opentelemetry/instrumentation-http',
);
assert(instrument);
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
instrument.setTracerProvider(provider);
instrument.setConfig({
  ...instrument.getConfig(),
  disableOutgoingRequestInstrumentation: true,
  ignoreIncomingRequestHook: (request) => request.url === '/already-private',
});
require('ts-node/register/transpile-only');
const {
  SmsTracePrivacy,
} = require('../../src/sms-marketing/sms.trace-privacy');
new SmsTracePrivacy().onModuleInit();
const http = require('node:http');
const { once } = require('node:events');
const server = http.createServer((_req, res) => res.end('ok'));
async function get(path) {
  await new Promise((resolve, reject) =>
    http
      .get(
        { hostname: '127.0.0.1', port: server.address().port, path },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      )
      .on('error', reject),
  );
}
async function main() {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  for (const path of [
    '/api/v1/admin/sms-marketing/opt-outs?search=%2B243900000001',
    '/api/v1/sms/s/Ab3dE9xK',
    '/api/v1/%73ms/s/Ab3dE9xK',
    '/already-private',
  ])
    await get(path);
  await provider.forceFlush();
  assert.equal(exporter.getFinishedSpans().length, 0);
  await get('/ordinary-trip');
  await provider.forceFlush();
  assert(exporter.getFinishedSpans().some((s) => s.kind === SpanKind.SERVER));
  const exported = exporter.getFinishedSpans().map((s) => ({
    name: s.name,
    attributes: s.attributes,
    events: s.events,
    status: s.status,
  }));
  assert(!/243900000001|Ab3dE9xK/.test(JSON.stringify(exported)));
  console.log(
    JSON.stringify({
      protectedRequests: 4,
      sensitiveSpans: 0,
      otherRoutesTraced: true,
    }),
  );
}
main()
  .catch(() => {
    console.error('SMS_INCOMING_TRACING_TEST_FAILED');
    process.exitCode = 1;
  })
  .finally(async () => {
    await new Promise((resolve) => server.close(resolve));
    instrument.disable();
    await provider.shutdown();
  });
