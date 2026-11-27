const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { forbiddenPath, inspect } = require('../scripts/security/check-sensitive-artifacts.cjs');

test('blocks plans, state, private variables and real env files, including nested paths', () => {
  for (const path of ['infra-aws/tfplan', 'tfplan.json', 'x/release.tfplan', 'x/release.tfplan.zip',
    'x/state.tfstate.backup', 'x/.terraform/terraform.tfstate', 'infra-aws/operators.tfvars',
    'terraform.tfvars.json', '.env', 'x/.env.production', 'x/.env.test.local']) assert.ok(forbiddenPath(path), path);
  for (const path of ['.env.example', '.env.production.example', 'infra-aws/production.auto.tfvars',
    'infra-aws/terraform.tfvars.example', 'infra-aws/docs/secret-incident-response.md',
    'test/terraform-backend.test.cjs']) assert.equal(forbiddenPath(path), false, path);
});

test('finds deleted artifacts on other refs without reading or logging their secrets', t => {
  const dir = mkdtempSync(join(tmpdir(), 'zwanga-artifact-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Synthetic test'); git('config', 'user.email', 'test@example.invalid');
  mkdirSync(join(dir, 'infra-aws'));
  const sentinel = ['synthetic', 'never-log-this'].join('-');
  writeFileSync(join(dir, 'infra-aws', 'tfplan'), sentinel);
  git('add', 'infra-aws/tfplan'); git('commit', '-m', 'synthetic artifact');
  git('branch', 'old-snapshot');
  git('rm', 'infra-aws/tfplan'); git('commit', '-m', 'remove artifact');
  assert.deepEqual(inspect(dir), []);
  assert.deepEqual(inspect(dir, true), ['infra-aws/tfplan']);
  const run = spawnSync(process.execPath, [join(__dirname, '../scripts/security/check-sensitive-artifacts.cjs'), '--history'],
    { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('infra-aws/tfplan'));
  assert.ok(!(run.stdout + run.stderr).includes(sentinel));
  // An incomplete checkout must never claim a clean historical scan.
  writeFileSync(join(dir, '.git', 'shallow'), git('rev-parse', 'HEAD'));
  assert.throws(() => inspect(dir, true), /Full Git history is required/);
});

test('fails closed outside a repository', t => {
  const dir = mkdtempSync(join(tmpdir(), 'zwanga-artifact-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [join(__dirname, '../scripts/security/check-sensitive-artifacts.cjs')],
    { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 2);
});

test('CI scans all history, redacts, verifies binary checksums and uploads nothing', () => {
  const action = yaml.load(readFileSync('.github/actions/secret-scan/action.yml', 'utf8'));
  const shell = action.runs.steps.map(step => step.run || '').join('\n');
  assert.match(shell, /--redact=100/);
  assert.match(shell, /--log-opts="--all --full-history"/);
  assert.match(shell, /--max-archive-depth=3/);
  assert.match(shell, /sha256sum --check --status/);
  assert.match(shell, /check-sensitive-artifacts.cjs --history/);
  assert.doesNotMatch(shell, /baseline-path|--exit-code[ =]0|--verbose/);
  const workflow = yaml.load(readFileSync('.github/workflows/secret-scan.yml', 'utf8'));
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.ok('pull_request' in workflow.on && 'push' in workflow.on && 'schedule' in workflow.on);
  assert.ok(!('pull_request_target' in workflow.on));
  assert.equal(workflow.jobs.secrets.steps[0].with['fetch-depth'], 0);
  assert.equal(workflow.jobs.secrets.steps[0].with['persist-credentials'], false);
  assert.ok(!workflow.jobs.secrets.steps.some(step => step.uses?.includes('upload-artifact')));
});

test('deployment and migration scans gate cloud credentials without blocking staging stop', () => {
  for (const file of ['deploy.yml', 'deploy-staging.yml', 'main.yml']) {
    const workflow = yaml.load(readFileSync(`.github/workflows/${file}`, 'utf8'));
    const steps = Object.values(workflow.jobs)[0].steps;
    const scan = steps.findIndex(step => step.uses === './.github/actions/secret-scan');
    const credentials = steps.findIndex(step => step.uses?.includes('configure-aws-credentials'));
    assert.ok(scan > 0 && credentials > scan, file);
    assert.equal(steps[0].with['fetch-depth'], 0);
    assert.ok(!steps[scan]['continue-on-error']);
    if (file === 'deploy-staging.yml') assert.equal(steps[scan].if, "inputs.action == 'deploy' || inputs.action == 'bootstrap'");
    else assert.equal(steps[scan].if, undefined);
  }
});

test('Redis rotation controls preserve defaults and prohibit removing AUTH', () => {
  const variables = readFileSync('infra-aws/secret-rotation.tf', 'utf8');
  const redis = readFileSync('infra-aws/redis.tf', 'utf8');
  assert.match(variables, /default\s*=\s*"ROTATE"/);
  assert.match(variables, /contains\(\["ROTATE", "SET"\]/);
  assert.match(variables, /default\s*=\s*false/);
  assert.match(redis, /auth_token_update_strategy\s*=\s*var.redis_auth_token_update_strategy/);
  assert.match(redis, /apply_immediately\s*=\s*var.redis_apply_immediately/);
});
