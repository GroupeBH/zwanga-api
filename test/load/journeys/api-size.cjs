'use strict';

// Deliberately finite choices: these change disposable container limits only.
// SQL pools, V8 heap and all business/latency safety gates stay unchanged.
const SIZES = Object.freeze({
  baseline: Object.freeze({ cpuPerReplica: 0.5, memoryMiBPerReplica: 1024 }),
  larger: Object.freeze({ cpuPerReplica: 1, memoryMiBPerReplica: 2048 }),
});
function apiSize(name = 'baseline') {
  if (!Object.hasOwn(SIZES, name)) throw new Error('API size must be baseline or larger');
  return { ...SIZES[name] };
}
function apiLimits(p) {
  const limits = apiSize(p.apiSize ?? 'baseline');
  if (!p.containerizedApi && p.apiSize && p.apiSize !== 'baseline')
    throw new Error('API size comparisons require --containerized-api; native processes have no enforced CPU/RAM limits');
  return p.containerizedApi ? limits : null;
}
module.exports = { apiSize, apiLimits };
