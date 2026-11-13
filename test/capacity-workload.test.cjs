const test = require('node:test');
const assert = require('node:assert/strict');
const { workload } = require('../infra-aws/scripts/capacity-workload.cjs');

test('1000 occupied and 1000 available drivers are distinct capacity needs', () => {
  const r = workload();
  assert.equal(r.sockets, 4000);
  assert.equal(r.gpsPerSecond, 200);
  assert.ok(Math.abs(r.presencePerSecond - 1000 / 15) < 1e-9);
  assert.equal(r.requestArrivalsPerSecond, 200);
  assert.equal(workload({ burstSeconds: 1 }).requestArrivalsPerSecond, 1000);
  assert.equal(r.reconnectsPerSecondDuringIncident, 400);
  assert.equal(r.alb.activeConnectionLcu, 4 / 3);
});
test('rolling SQL budget accounts for duplicate tasks and migration process', () => {
  assert.deepEqual(workload().connections, { steady: 20, rolling: 40, requiredWithMigrationAndOperations: 52 });
});
test('duration and payload can consume the budget without any extra task', () => {
  const short = workload();
  const steady = workload({ peakHoursPerDay: 24 });
  const large = workload({ peakHoursPerDay: 24, payloadBytes: 2048 });
  assert.ok(steady.peakOnlyMonthlyOutboundGb > short.peakOnlyMonthlyOutboundGb);
  assert.ok(steady.illustrativeCost.estimatedUsd > short.illustrativeCost.estimatedUsd);
  assert.equal(large.illustrativeCost.withinIllustrativeBudget, false);
  assert.equal(large.capacityValidated, false);
});
test('invalid assumptions are not silently accepted', () => {
  for (const options of [{ peakHoursPerDay: 25 }, { activeTrips: -1 }, { availableDrivers: 1.5 },
    { payloadBytes: NaN }, { gpsIntervalSeconds: 0 }, { burstSeconds: Infinity }]) {
    assert.throws(() => workload(options));
  }
});
