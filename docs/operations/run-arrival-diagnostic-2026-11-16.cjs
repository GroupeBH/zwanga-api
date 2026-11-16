'use strict';
// Requires the user's approval for ONE temporary task; never changes the service.
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== '--run-authorized') process.exit(1);
const call = args => JSON.parse(execFileSync('aws', [...args, '--region','eu-central-1','--output','json','--no-cli-pager'],
  { encoding:'utf8', timeout:60000, maxBuffer:2*1024*1024, windowsHide:true, stdio:['ignore','pipe','pipe'] }));
try {
  const cluster='zwanga-api-production-cluster';
  const definition='arn:aws:ecs:eu-central-1:046374119247:task-definition/zwanga-api-production-api:42';
  const live=call(['ecs','describe-services','--cluster',cluster,'--services','zwanga-api-production-api']).services?.[0];
  if (live?.taskDefinition!==definition || live.deployments?.length!==1 || live.deployments[0].rolloutState!=='COMPLETED') throw new Error();
  const task=call(['ecs','describe-task-definition','--task-definition',definition]).taskDefinition;
  const api=task.containerDefinitions.find(c=>c.name==='api');
  if (!api?.essential || !api.image.endsWith('@sha256:52594cd421eb1a2c260cb608002f8fc0d3bd80cf3cde2213bf6a315f2bfd5c51')) throw new Error();
  const program=readFileSync(path.join(__dirname,'arrival-diagnostic-2026-11-16.cjs'),'utf8');
  const overrides=JSON.stringify({containerOverrides:[{name:'api',command:['node','-e',program]}]});
  if (overrides.length>8192) throw new Error();
  const existing=call(['ecs','list-tasks','--cluster',cluster,'--started-by','arrival-audit-20261116']);
  if (existing.taskArns?.length) throw new Error();
  const result=call(['ecs','run-task','--cluster',cluster,'--task-definition',definition,'--launch-type','FARGATE',
    '--platform-version',live.platformVersion||'LATEST','--count','1','--started-by','arrival-audit-20261116',
    '--client-token','arrival-audit-20261116-9710-v1','--network-configuration',JSON.stringify(live.networkConfiguration),'--overrides',overrides]);
  console.log(JSON.stringify({tasks:result.tasks?.map(t=>({arn:t.taskArn,status:t.lastStatus})),failures:result.failures}));
  if(result.failures?.length || result.tasks?.length!==1) process.exitCode=1;
} catch {
  console.error('Launch failed or outcome unknown. Check startedBy arrival-audit-20261116 before any retry; preserve client token.');
  process.exitCode=1;
}
