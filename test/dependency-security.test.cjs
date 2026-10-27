const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const multer = require('multer');
const grpc = require('@grpc/grpc-js');

test('updated Express and Multer accept a file and reject oversized uploads', async t => {
  const app = express();
  app.post('/upload', multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 } }).single('file'),
    (req, res) => res.json({ size: req.file.size }));
  app.use((error, req, res, next) => res.status(413).json({ code: error.code }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  for (const [size, status] of [[16, 200], [2048, 413]]) {
    const data = new FormData(); data.set('file', new Blob([Buffer.alloc(size)]), 'test.txt');
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/upload', {
      method: 'POST', body: data, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, status);
    const body = await response.json();
    if (status === 200) assert.equal(body.size, size);
    else assert.equal(body.code, 'LIMIT_FILE_SIZE');
  }
});

test('patched gRPC completes a local unary request used by Google client libraries', async t => {
  const encode = value => Buffer.from(JSON.stringify(value));
  const decode = value => JSON.parse(value.toString());
  const server = new grpc.Server();
  const definition = { echo: { path: '/security.Test/Echo', requestStream: false, responseStream: false,
    requestSerialize: encode, requestDeserialize: decode, responseSerialize: encode, responseDeserialize: decode } };
  server.addService(definition, { echo: (call, done) => done(null, call.request) });
  t.after(() => server.forceShutdown());
  const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(),
    (error, value) => error ? reject(error) : resolve(value)));
  const client = new grpc.Client('127.0.0.1:' + port, grpc.credentials.createInsecure());
  t.after(() => client.close());
  const result = await new Promise((resolve, reject) => client.makeUnaryRequest('/security.Test/Echo', encode, decode,
    { notification: 'synthetic' }, { deadline: Date.now() + 5000 }, (error, value) => error ? reject(error) : resolve(value)));
  assert.deepEqual(result, { notification: 'synthetic' });
});

test('ADOT can construct all instrumentations with the patched database packages', () => {
  const { createRequire } = require('node:module');
  const fromAdot = createRequire(require.resolve('@aws/aws-distro-opentelemetry-node-autoinstrumentation/register'));
  const { getNodeAutoInstrumentations } = fromAdot('@opentelemetry/auto-instrumentations-node');
  const instrumentations = getNodeAutoInstrumentations();
  assert.ok(instrumentations.some(item => item.instrumentationName === '@opentelemetry/instrumentation-pg'));
  for (const item of instrumentations) item.disable();
  assert.ok(require.resolve('@aws/aws-distro-opentelemetry-node-autoinstrumentation/register'));
});


test('native image and password modules work with the selected Node LTS', async () => {
  const sharp = require('sharp');
  const bcrypt = require('bcrypt');
  const image = await sharp({ create: { width: 2, height: 3, channels: 4, background: '#ffffff' } }).png().toBuffer();
  const metadata = await sharp(image).metadata();
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 3);
  const hash = await bcrypt.hash('synthetic-test-only', 4);
  assert.equal(await bcrypt.compare('synthetic-test-only', hash), true);
  assert.equal(await bcrypt.compare('wrong-test-value', hash), false);
});

test('Swagger can serialize OpenAPI with the patched YAML major version', () => {
  const { createRequire } = require('node:module');
  const fromSwagger = createRequire(require.resolve('@nestjs/swagger'));
  const yaml = fromSwagger('js-yaml');
  const document = { openapi: '3.0.0', info: { title: 'Test', version: '1.0' }, paths: {} };
  assert.deepEqual(yaml.load(yaml.dump(document, { skipInvalid: true, noRefs: true })), document);
});
