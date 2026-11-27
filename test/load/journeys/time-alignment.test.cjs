'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { verifyTimeAlignment } = require('./time-alignment.cjs');
process.env.TZ = 'UTC';

const now = new Date('2026-11-23T14:30:00.000Z');
const sample = (changes = {}) => ({ zoned: now, local: now, databaseTimezone: 'UTC', ...changes });
const db = row => ({ query: async () => row ? [row] : [] });

test('timezone preflight verifies both timestamp decodings with one bounded query', async () => {
  let queries = 0;
  const result = await verifyTimeAlignment({ query: async sql => {
    queries++; assert.match(sql, /CURRENT_TIMESTAMP.*zoned/);
    assert.match(sql, /LOCALTIMESTAMP.*local/); return [sample()];
  } });
  assert.equal(queries, 1);
  assert.deepEqual(result, { nodeTimezone: 'UTC', nodeOffsetMinutes: 0,
    databaseTimezone: 'UTC', timestampOffsetMs: 0, checkedAt: now.toISOString() });
});

test('timezone preflight rejects an hour of skew in either direction', async () => {
  for (const delta of [-3600000, 3600000]) {
    await assert.rejects(verifyTimeAlignment(db(sample({ local: new Date(+now + delta) }))), /timezone mismatch/);
  }
});

test('timezone preflight fails closed for absent, invalid or non-UTC evidence', async () => {
  for (const row of [undefined, {}, sample({ local: now.toISOString() }), sample({ local: new Date(NaN) }),
    sample({ zoned: new Date(NaN) }), sample({ databaseTimezone: 'Africa/Kinshasa' })]) {
    await assert.rejects(verifyTimeAlignment(db(row)), /timezone mismatch/);
  }
});

test('non-UTC child cannot pass preflight even when database timestamps look aligned', () => {
  const script = `require(${JSON.stringify(join(__dirname, 'time-alignment.cjs'))})
    .verifyTimeAlignment({query:()=>{throw new Error('Must not query')}})
    .catch(e=>process.stdout.write(e.message))`;
  const result = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: 'Africa/Kinshasa' }, encoding: 'utf8', windowsHide: true,
  });
  assert.match(result, /Node must use TZ=UTC/);
});

test('runner and sanitized API environment explicitly pin UTC; container preserves it', () => {
  assert.match(readFileSync(join(__dirname, 'run.cjs'), 'utf8'), /process\.env\.TZ = 'UTC'/);
  assert.match(readFileSync(join(__dirname, 'resources.cjs'), 'utf8'), /minimalEnvironment\(\{[^]*?TZ: 'UTC'/);
  assert.match(readFileSync(join(__dirname, 'container-child.cjs'), 'utf8'), /const values = \{ \.\.\.env,/);
});
