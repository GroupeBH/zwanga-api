// Optional local probe of the actual pinned scanner; no real key or network.
// node test/gitleaks-smoke.cjs /absolute/path/to/gitleaks
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const executable = process.argv[2];
if (!executable) throw new Error('Provide the path to the verified Gitleaks binary.');
const synthetic = randomBytes(32).toString('hex');
function scan(input) {
  const result = spawnSync(resolve(executable), ['stdin', '--redact=100', '--no-banner', '--log-level=error'],
    { input, encoding: 'utf8', timeout: 30000 });
  // Never print subprocess output or the synthetic value, even on failure.
  assert.ok(!(result.stdout || '').includes(synthetic), 'stdout must be redacted');
  assert.ok(!(result.stderr || '').includes(synthetic), 'stderr must be redacted');
  return result.status;
}
assert.equal(scan('const unrelated = 42;\n'), 0, 'clean input');
assert.equal(scan(`API_KEY="${synthetic}"\n`), 1, 'synthetic secret must block');
console.log('Pinned Gitleaks smoke checks passed: clean input, secret detection, redaction.');
