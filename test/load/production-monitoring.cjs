'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');

const ALLOWED = new Set(['sts:get-caller-identity', 'ecs:describe-services',
  'ecs:describe-task-definition', 'elbv2:describe-target-health', 'cloudwatch:get-metric-data',
  'cloudwatch:describe-alarms', 'rds:describe-db-instances', 'elasticache:describe-replication-groups',
  'sns:list-subscriptions-by-topic']);
const AWS_CODES = new Set(['AccessDenied', 'AccessDeniedException', 'Throttling', 'ThrottlingException',
  'TooManyRequestsException', 'RequestExpired', 'ExpiredToken', 'ExpiredTokenException',
  'InvalidClientTokenId', 'UnrecognizedClientException', 'InvalidParameterValue', 'ValidationError',
  'InternalServiceError', 'InternalError', 'ServiceUnavailable']);
const PROCESS_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']);

// Never retain stderr/stdout, command arguments, credentials or error.message:
// execFile errors include the complete command and AWS errors can contain identity data.
function classifyFailure(error, phase) {
  if (phase === 'json') return { kind: 'invalid_json' };
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  const awsCode = stderr.match(/An error occurred \(([A-Za-z][A-Za-z0-9]{0,63})\)/)?.[1];
  let kind = 'cli_failure';
  if (error?.killed) kind = 'process_terminated';
  else if (/Read timeout/i.test(stderr)) kind = 'read_timeout';
  else if (/Connect timeout|Connection timeout/i.test(stderr)) kind = 'connect_timeout';
  else if (/Could not connect to the endpoint URL|EndpointConnectionError/i.test(stderr)) kind = 'endpoint_unreachable';
  else if (/SSL validation failed/i.test(stderr)) kind = 'tls_failure';
  else if (/Unable to locate credentials/i.test(stderr)) kind = 'credentials_unavailable';
  else if (awsCode) kind = 'aws_service_error';
  return { kind,
    ...(Number.isSafeInteger(error?.code) ? { exitCode: error.code } : {}),
    ...(PROCESS_CODES.has(error?.code) ? { processCode: error.code } : {}),
    ...(['SIGTERM', 'SIGKILL', 'SIGINT'].includes(error?.signal) ? { signal: error.signal } : {}),
    ...(AWS_CODES.has(awsCode) ? { awsCode } : {}) };
}

function createAwsReader({ region, execute = promisify(execFile), onDiagnostic = () => {} }) {
  return async function aws(service, operation, ...args) {
    if (!ALLOWED.has(`${service}:${operation}`)) throw new Error('AWS operation is not read-only/allowlisted');
    const started = performance.now(), at = new Date().toISOString();
    let phase = 'execute';
    try {
      const { stdout } = await execute(process.platform === 'win32' ? 'aws.exe' : 'aws',
        [service, operation, ...args, '--region', region, '--output', 'json', '--no-cli-pager',
          '--cli-connect-timeout', '5', '--cli-read-timeout', '10'],
        { windowsHide: true, timeout: 20000, maxBuffer: 3 * 1024 * 1024,
          env: { ...process.env, AWS_MAX_ATTEMPTS: '1', AWS_PAGER: '' } });
      phase = 'json';
      const result = JSON.parse(stdout);
      onDiagnostic({ at, operation: `${service}/${operation}`, ok: true,
        elapsedMs: Math.round(performance.now() - started) });
      return result;
    } catch (cause) {
      const diagnostic = { at, operation: `${service}/${operation}`, ok: false,
        elapsedMs: Math.round(performance.now() - started), ...classifyFailure(cause, phase) };
      onDiagnostic(diagnostic);
      const error = new Error(`Read-only monitoring unavailable: ${service}/${operation}`);
      error.monitoringDiagnostic = diagnostic;
      throw error;
    }
  };
}

module.exports = { createAwsReader, classifyFailure };
