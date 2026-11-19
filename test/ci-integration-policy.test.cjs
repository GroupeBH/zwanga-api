const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const yaml = require('js-yaml');
for (const file of ['deploy.yml', 'deploy-staging.yml']) test(`${file}: integration tests and security checks cannot silently be omitted`, () => {
  const workflow = yaml.load(readFileSync(`.github/workflows/${file}`, 'utf8'));
  const steps = Object.values(workflow.jobs)[0].steps;
  const commands = steps.map(step => step.run || '').join('\n');
  for (const flag of ['INSTALLATION_UPDATES', 'ACCOUNT_LIFECYCLE', 'MIXED_CASH', 'RESILIENCE', 'TRIP_SEARCH', 'NEARBY_RING', 'PAID_SUBSIDY', 'ZONES', 'ASSET', 'PRO_CREDIT']) {
    // Verify the actual exported suite list, not an incidental mention in a comment.
    const suiteLoop = commands.match(/for suite in ([^;]+); do\s+echo "\$\{suite\}_TEST_POSTGRES_BIN=\/usr\/lib\/postgresql\/16\/bin" >> "\$\{GITHUB_ENV\}"/);
    assert.ok(suiteLoop && suiteLoop[1].split(/\s+/).includes(flag), flag);
  }
  assert.ok(commands.includes('node test/run-otp-redis.cjs'));
  assert.ok(commands.includes('DISPATCH_TEST_REDIS_PORT=16379'));
  assert.ok(commands.includes('npm audit --omit=dev --audit-level=high'));
  assert.ok(steps.some(step => step.if?.startsWith('always()') && step.run?.includes('shutdown nosave')));
});
