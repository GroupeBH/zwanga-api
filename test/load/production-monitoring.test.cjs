'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAwsReader, classifyFailure } = require('./production-monitoring.cjs');

test('reader keeps the operation allowlist, deadlines and single attempt unchanged', async () => {
  const diagnostics = [];
  let calls = 0;
  const aws = createAwsReader({ region: 'eu-central-1', onDiagnostic: d => diagnostics.push(d),
    execute: async (_command, args, options) => {
      calls++;
      assert.equal(args[args.indexOf('--cli-connect-timeout') + 1], '5');
      assert.equal(args[args.indexOf('--cli-read-timeout') + 1], '10');
      assert.equal(options.timeout, 20000);
      assert.equal(options.env.AWS_MAX_ATTEMPTS, '1');
      assert.equal(options.windowsHide, true);
      return { stdout: '{"value":42}' };
    } });
  await assert.rejects(aws('ecs', 'update-service'), /not read-only/);
  assert.equal(calls, 0);
  assert.deepEqual(await aws('cloudwatch', 'get-metric-data'), { value: 42 });
  assert.equal(calls, 1);
  assert.equal(diagnostics[0].ok, true);
  assert.ok(diagnostics[0].elapsedMs >= 0);
  assert.equal(JSON.stringify(diagnostics).includes('value'), false);
});

test('CLI errors fail closed without retry and retain only sanitized diagnostics', async () => {
  const diagnostics = [];
  let calls = 0;
  const aws = createAwsReader({ region: 'eu-central-1', onDiagnostic: d => diagnostics.push(d),
    execute: async () => {
      calls++;
      throw Object.assign(new Error('command with SECRET'), { code: 254, stdout: 'SECRET',
        stderr: 'An error occurred (AccessDeniedException) when calling operation: SECRET' });
    } });
  await assert.rejects(aws('cloudwatch', 'get-metric-data'), error => {
    assert.equal(error.message, 'Read-only monitoring unavailable: cloudwatch/get-metric-data');
    assert.equal(error.monitoringDiagnostic.awsCode, 'AccessDeniedException');
    assert.equal(error.monitoringDiagnostic.kind, 'aws_service_error');
    assert.equal(error.monitoringDiagnostic.exitCode, 254);
    assert.equal(JSON.stringify(error).includes('SECRET'), false);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(diagnostics.length, 1);
  assert.equal(JSON.stringify(diagnostics).includes('SECRET'), false);
});

test('invalid JSON remains a monitoring failure without exposing the response', async () => {
  const diagnostics = [];
  const aws = createAwsReader({ region: 'eu-central-1', onDiagnostic: d => diagnostics.push(d),
    execute: async () => ({ stdout: 'SECRET invalid response' }) });
  await assert.rejects(aws('cloudwatch', 'get-metric-data'), /monitoring unavailable/);
  assert.equal(diagnostics[0].kind, 'invalid_json');
  assert.equal(JSON.stringify(diagnostics).includes('SECRET'), false);
});

test('classification distinguishes CLI termination, network timeouts, credentials and AWS errors', () => {
  for (const [error, kind] of [
    [{ killed: true, signal: 'SIGTERM' }, 'process_terminated'],
    [{ stderr: 'Read timeout on endpoint URL: SECRET' }, 'read_timeout'],
    [{ stderr: 'Connect timeout on endpoint URL: SECRET' }, 'connect_timeout'],
    [{ stderr: 'Could not connect to the endpoint URL: SECRET' }, 'endpoint_unreachable'],
    [{ stderr: 'SSL validation failed for SECRET' }, 'tls_failure'],
    [{ stderr: 'Unable to locate credentials' }, 'credentials_unavailable'],
    [{ stderr: 'An error occurred (ThrottlingException)' }, 'aws_service_error'],
    [{ code: 'ENOENT' }, 'cli_failure'],
  ]) assert.equal(classifyFailure(error, 'execute').kind, kind);
  const unknown = classifyFailure({ code: 'SECRET', signal: 'SECRET', message: 'SECRET',
    stderr: 'An error occurred (SECRET)', stdout: 'SECRET' }, 'execute');
  assert.deepEqual(unknown, { kind: 'aws_service_error' });
});
