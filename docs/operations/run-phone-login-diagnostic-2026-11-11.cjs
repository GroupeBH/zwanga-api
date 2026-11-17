'use strict';

// Explicitly authorized one-off production diagnostic, not a deployment.
// The idempotency token must not change if a response is interrupted/lost.
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== '--run-authorized') {
  console.error('Requires explicit --run-authorized; creates one temporary Fargate task.');
  process.exit(1);
}
const aws = process.platform === 'win32'
  ? 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe' : 'aws';
const call = args => JSON.parse(execFileSync(aws,
  [...args, '--region','eu-central-1','--output','json','--no-cli-pager'],
  { encoding: 'utf8', timeout: 60000, maxBuffer: 2*1024*1024, windowsHide: true,
    stdio: ['ignore','pipe','pipe'] }));
try {
  const cluster = 'zwanga-api-production-cluster';
  const service = 'zwanga-api-production-api';
  const definition = 'arn:aws:ecs:eu-central-1:046374119247:task-definition/zwanga-api-production-api:41';
  const response = call(['ecs','describe-services','--cluster',cluster,'--services',service]);
  const live = response.services?.[0];
  if (response.failures?.length || live?.taskDefinition !== definition ||
      live?.deployments?.length !== 1 || live.deployments[0].rolloutState !== 'COMPLETED') {
    throw new Error('Production revision changed or rollout active; abort diagnostic.');
  }
  const program = readFileSync(path.join(__dirname, 'phone-login-diagnostic-2026-11-11.cjs'), 'utf8');
  const result = call(['ecs','run-task','--cluster',cluster,'--task-definition',definition,
    '--launch-type','FARGATE','--platform-version',live.platformVersion || 'LATEST',
    '--count','1','--started-by','phone-login-audit-20261111',
    '--client-token','phone-login-audit-20261111-710-654-v1',
    '--network-configuration',JSON.stringify(live.networkConfiguration),
    '--overrides',JSON.stringify({ containerOverrides: [{ name: 'api', command: ['node','-e',program] }] }),
  ]);
  console.log(JSON.stringify({
    tasks: result.tasks?.map(task => ({ arn: task.taskArn, status: task.lastStatus, definition: task.taskDefinitionArn })),
    failures: result.failures?.map(failure => ({ reason: failure.reason })),
  }));
  if (result.failures?.length || result.tasks?.length !== 1) process.exitCode=1;
} catch {
  // A network timeout after run-task does not prove no task exists: inspect
  // startedBy/client-token before any retry. Never print subprocess buffers.
  console.error('Diagnostic launch failed or response unknown. Inspect ECS startedBy phone-login-audit-20261111 before retry.');
  process.exitCode=1;
}
