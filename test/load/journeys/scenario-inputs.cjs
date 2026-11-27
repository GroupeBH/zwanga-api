'use strict';
const { createHash } = require('node:crypto');
const DEFAULT_FIXTURE_SEED = 'replica-balance-v1';
function validateSeed(seed) {
  if (typeof seed !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(seed)) throw new Error('Invalid synthetic fixture seed');
  return seed;
}
function fixtureIds(seed = DEFAULT_FIXTURE_SEED) {
  validateSeed(seed); let index = 0;
  // Only synthetic entity IDs. JWT secrets, Redis passwords and lease tokens
  // used by the running backend remain cryptographically random.
  return () => {
    const bytes = createHash('sha256').update(`zwanga-load:${seed}:${index++}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}
function scenarioOptions(args, replicas) {
  const seeds = args.filter(a => a.startsWith('--fixture-seed='));
  const offsets = args.filter(a => a.startsWith('--replica-offset='));
  if (seeds.length > 1 || offsets.length > 1) throw new Error('Duplicate scenario option');
  const fixtureSeed = validateSeed(seeds.length ? seeds[0].slice('--fixture-seed='.length) : DEFAULT_FIXTURE_SEED);
  const value = offsets.length ? offsets[0].slice('--replica-offset='.length) : '0';
  if (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) >= replicas) throw new Error('Invalid replica rotation');
  return { fixtureSeed, replicaOffset: Number(value) };
}
function replicaFor(index, p) { return (index + (p.replicaOffset ?? 0)) % p.replicas; }
module.exports = { DEFAULT_FIXTURE_SEED, fixtureIds, scenarioOptions, replicaFor };
