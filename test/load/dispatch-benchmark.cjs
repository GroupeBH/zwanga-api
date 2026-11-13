'use strict';

// Opt-in, bounded fixture sizes. This does not change production settings.
function benchmarkSettings(env = process.env) {
  const integer = (key, fallback, max) => {
    const raw = env[key];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${key}: expected integer 1..${max}`);
    return value;
  };
  const stage = env.DISPATCH_TEST_LOAD_STAGE ?? 'both';
  if (!['both', 'serial', 'concurrent'].includes(stage)) throw new Error('Invalid DISPATCH_TEST_LOAD_STAGE');
  const requests = integer('DISPATCH_TEST_LOAD_REQUESTS', 60, 1000);
  const concurrency = integer('DISPATCH_TEST_LOAD_CONCURRENCY', 8, 32);
  const replicas = integer('DISPATCH_TEST_LOAD_REPLICAS', 3, 4);
  return { requests, drivers: requests * 2, replicas,
    stages: [{ name: 'serial', concurrency: 1 }, { name: 'concurrent', concurrency }]
      .filter(item => stage === 'both' || item.name === stage) };
}
module.exports = { benchmarkSettings };
