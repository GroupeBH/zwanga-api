const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const read = file => readFileSync(resolve(__dirname, '..', file), 'utf8');
// Static regression guards; terraform validate additionally checks the HCL.
// These checks do not simulate IAM or prove delivery in AWS.
function document(file, name) {
  const source = read(file);
  const marker = `data "aws_iam_policy_document" "${name}" {`;
  assert.ok(source.includes(marker), `Missing ${name}`);
  return source.split(marker)[1].split(/^}/m)[0];
}

for (const [file, name, sid] of [
  ['infra-aws/iam-ecs.tf', 'ecs_task_execution_secrets', 'EncryptExecutionLogsViaCloudWatch'],
  ['infra-aws/cloudtrail.tf', 'cloudtrail_logs', 'EncryptAuditLogsViaCloudWatch'],
]) {
  test(`${name}: KMS access requires the observability key, Logs and exact context`, () => {
    const policy = document(file, name);
    const statement = policy.slice(policy.indexOf(`sid       = "${sid}"`));
    assert.ok(policy.includes(sid));
    assert.match(statement, /effect\s*=\s*"Allow"/);
    assert.match(statement, /actions\s*=\s*\["kms:GenerateDataKey", "kms:Decrypt"\]/);
    assert.match(statement, /resources\s*=\s*\[aws_kms_key\.observability\.arn\]/);
    assert.match(statement, /test\s*=\s*"StringEquals"\s+variable\s*=\s*"kms:ViaService"\s+values\s*=\s*\["logs\.\$\{var\.aws_region\}\.amazonaws\.com"\]/);
    assert.match(statement, /test\s*=\s*"ArnEquals"\s+variable\s*=\s*"kms:EncryptionContext:aws:logs:arn"/);
    assert.doesNotMatch(statement, /"kms:\*"|IfExists|ArnLike|"kms:ReEncrypt\*"/);
  });
}

test('execution scope includes API, import and optional collector, not audit logs', () => {
  const policy = document('infra-aws/iam-ecs.tf', 'ecs_task_execution_secrets');
  for (const group of ['ecs_app', 'database_import']) {
    assert.ok(policy.includes(`trimsuffix(aws_cloudwatch_log_group.${group}.arn, ":*")`));
  }
  assert.ok(policy.includes('[for group in aws_cloudwatch_log_group.ecs_otel : trimsuffix(group.arn, ":*")]'));
  assert.doesNotMatch(policy, /ecs_otel\[0\]|aws_cloudwatch_log_group\.cloudtrail/);
  assert.match(policy, /actions\s*=\s*\["kms:Decrypt"\]\s+resources\s*=\s*\[aws_kms_key\.application\.arn\]/);
});

test('audit delivery scope cannot use the ECS log groups', () => {
  const policy = document('infra-aws/cloudtrail.tf', 'cloudtrail_logs');
  assert.ok(policy.includes('values   = [trimsuffix(aws_cloudwatch_log_group.cloudtrail.arn, ":*")]'));
  assert.doesNotMatch(policy, /aws_cloudwatch_log_group\.(ecs_app|ecs_otel|database_import)/);
});

test('both deployment pipelines run the KMS regression guards', () => {
  for (const file of ['.github/workflows/deploy.yml', '.github/workflows/deploy-staging.yml']) {
    assert.match(read(file), /node --test test\/ci-integration-policy\.test\.cjs test\/observability-kms\.test\.cjs/);
  }
});
