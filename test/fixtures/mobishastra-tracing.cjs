'use strict';

// Child-process fixture: patch HTTP before loading Nest/Axios, as ADOT does.
// Every connection terminates on loopback. No .env, AWS or real SMS.
const assert = require('node:assert/strict');
const { context, trace, SpanKind } = require('@opentelemetry/api');
const { isTracingSuppressed } = require('@opentelemetry/core');
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
const instrumentation = new HttpInstrumentation({
  disableIncomingRequestInstrumentation: true,
});
instrumentation.setTracerProvider(provider);
instrumentation.enable();

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
const {
  MobishastraSmsService,
} = require('../../src/otp/mobishastra-sms.service');
Logger.overrideLogger(false);
const sockets = new Set();
let reply = '000 - Send Successful';
let reached = 0;
const origin = https.createServer(
  { key: privateKey, cert: certificate },
  (req, res) => {
    reached++;
    res.end(reply);
  },
);
const proxy = http.createServer((_req, res) => res.end('baseline'));
for (const server of [origin, proxy])
  server.on('connection', (socket) => sockets.add(socket));
proxy.on('connect', (req, downstream, head) => {
  if (req.url !== 'mshastra.com:443') {
    downstream.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
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
  // Positive control: suppression must not silently disable all application tracing.
  await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${proxy.address().port}/baseline`, (res) => {
        res.resume();
        res.on('end', resolve);
      })
      .on('error', reject);
  });
  await provider.forceFlush();
  assert(
    exporter.getFinishedSpans().some((span) => span.kind === SpanKind.CLIENT),
  );
  exporter.reset();
  const client = axios.create();
  client.interceptors.request.use((config) => {
    config.httpsAgent.options.ca = certificate;
    return config;
  });
  service = new MobishastraSmsService(
    new ConfigService({
      NODE_ENV: 'test',
      MOBISHASTRA_PROFILE_ID: 'synthetic-profile',
      MOBISHASTRA_PASSWORD: 'synthetic-password',
      MOBISHASTRA_SENDER_ID: 'ZWANGA',
      MOBISHASTRA_PROXY_URL: `http://127.0.0.1:${proxy.address().port}`,
      MOBISHASTRA_PROXY_REQUIRED: 'true',
    }),
    new HttpService(client),
  );
  await service.sendCode('243900000000', '12345');
  reply = '005 - Authorization failed synthetic-password 12345';
  await assert.rejects(service.sendCode('243900000000', '12345'), (error) => {
    assert.equal(error.getStatus(), 503);
    assert(!JSON.stringify(error).includes('12345'));
    assert(!JSON.stringify(error).includes('synthetic-password'));
    return true;
  });
  await provider.forceFlush();
  assert.equal(reached, 2);
  for (const purpose of ['pin_reset', 'pin_change']) {
    reply = '000 - Send Successful';
    await service.sendCode('243900000000', '123456', purpose);
    reply = '005 - Authorization failed synthetic-password 123456';
    await assert.rejects(
      service.sendCode('243900000000', '123456', purpose),
      (error) => {
        assert.equal(error.getStatus(), 503);
        assert(!JSON.stringify(error).includes('123456'));
        return true;
      },
    );
  }
  await provider.forceFlush();
  assert.equal(reached, 6);
  assert.equal(
    exporter.getFinishedSpans().length,
    0,
    'Sensitive SMS requests must not produce traces',
  );
  assert.equal(isTracingSuppressed(context.active()), false);
  await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${proxy.address().port}/after-sms`, (res) => {
        res.resume();
        res.on('end', resolve);
      })
      .on('error', reject);
  });
  await provider.forceFlush();
  assert(
    exporter.getFinishedSpans().some((span) => span.kind === SpanKind.CLIENT),
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    service?.onModuleDestroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [origin, proxy].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
    instrumentation.disable();
    await provider.shutdown();
    context.disable();
    trace.disable();
    manager.disable();
  });
