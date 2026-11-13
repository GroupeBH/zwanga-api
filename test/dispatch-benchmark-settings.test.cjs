const test = require('node:test');
const assert = require('node:assert/strict');
const { benchmarkSettings } = require('./load/dispatch-benchmark.cjs');

test('default preserves the historical 60-request comparison', () => {
  assert.deepEqual(benchmarkSettings({}), { requests: 60, drivers: 120, replicas: 3,
    stages: [{ name: 'serial', concurrency: 1 }, { name: 'concurrent', concurrency: 8 }] });
});
test('target burst can use two service objects and 1000 requests', () => {
  const settings = benchmarkSettings({ DISPATCH_TEST_LOAD_REQUESTS: '1000',
    DISPATCH_TEST_LOAD_REPLICAS: '2', DISPATCH_TEST_LOAD_STAGE: 'concurrent' });
  assert.equal(settings.drivers, 2000);
  assert.equal(settings.replicas, 2);
  assert.equal(settings.stages.length, 1);
});
test('invalid or unbounded fixture sizes fail before launching databases', () => {
  for (const value of ['', '0', '-1', '1001', '1.5', 'Infinity', 'abc']) {
    assert.throws(() => benchmarkSettings({ DISPATCH_TEST_LOAD_REQUESTS: value }));
  }
  assert.throws(() => benchmarkSettings({ DISPATCH_TEST_LOAD_CONCURRENCY: '33' }));
  assert.throws(() => benchmarkSettings({ DISPATCH_TEST_LOAD_REPLICAS: '5' }));
  assert.throws(() => benchmarkSettings({ DISPATCH_TEST_LOAD_STAGE: 'production' }));
});
