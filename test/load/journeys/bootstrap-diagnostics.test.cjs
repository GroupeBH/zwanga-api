'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapDiagnostics } = require('./bootstrap-diagnostics.cjs');

test('bootstrap telemetry is finite, ordered, bounded and contains no configuration', () => {
  const rows = [], mark = bootstrapDiagnostics(row => rows.push(row));
  for (const phase of ['load_dependencies', 'initialize_database', 'compile_nest', 'connect_redis', 'listen', 'ready']) mark(phase);
  assert.equal(rows.length, 6);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), ['marker', 'phase', 'elapsedMs', 'cpuMs', 'rssMiB']);
    for (const key of ['elapsedMs', 'cpuMs', 'rssMiB']) assert.ok(Number.isFinite(row[key]) && row[key] >= 0);
  }
  assert.throws(() => mark('ready'), /Invalid/);
  assert.throws(() => mark('load_dependencies'), /Invalid/);
  assert.throws(() => mark('private-id'), /Invalid/);
  assert.equal(rows.length, 6);
});
