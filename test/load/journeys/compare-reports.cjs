'use strict';
const { isDeepStrictEqual } = require('node:util');
const { apiSize } = require('./api-size.cjs');

function workload(plan) {
  if (!plan || !plan.safetyLimits) return null;
  const { apiResourceLimits, ...rest } = plan;
  return rest;
}
function reportProblems(report) {
  const problems = [];
  if (!report || report.localScenarioPassed !== true || report.currentPhase?.phase !== 'completed' ||
      !report.finishedAt || report.error || report.cleanup?.disposableDatabaseRemoved !== true ||
      !Array.isArray(report.cleanup?.errors) || report.cleanup.errors.length) problems.push('incomplete_or_failed_run');
  if (!/^[a-f0-9]{64}$/.test(report?.sourceHash ?? '') || !/^sha256:[a-f0-9]{64}$/.test(report?.apiImage ?? ''))
    problems.push('source_or_image_evidence_missing');
  if (!report?.preflight?.passed || report?.runtimeMatchesDeployment !== true ||
      report?.plan?.containerizedApi !== true || !report?.apiResourceLimits ||
      !isDeepStrictEqual(report.apiResourceLimits, report.plan.apiResourceLimits) ||
      !['baseline', 'larger'].some(size => isDeepStrictEqual(report?.apiResourceLimits, apiSize(size))))
    problems.push('limited_runtime_evidence_missing');
  if (typeof report?.node !== 'string' || typeof report?.architecture !== 'string' || report?.platform !== 'linux' ||
      !Number.isFinite(report?.host?.logicalCpus) || report.host.logicalCpus < 1 ||
      !Number.isFinite(report?.host?.memoryGiB) || report.host.memoryGiB <= 0 ||
      !Array.isArray(report?.workerSchedules) || report.workerSchedules.length !== report?.plan?.replicas)
    problems.push('host_or_worker_evidence_missing');
  if (!workload(report?.plan)) problems.push('workload_evidence_missing');
  const outcome = report?.outcomes, plan = report?.plan;
  if (!outcome || outcome.pickedUp !== plan?.activeTrips || outcome.droppedOff !== plan?.activeTrips ||
      outcome.requestsWithOffers !== plan?.additionalRequests || outcome.waveViolations !== 0 ||
      outcome.duplicateAcceptances !== 0 || outcome.duplicateDriverOffers !== 0) problems.push('business_outcomes_not_validated');
  return problems;
}
function summary(report) {
  const snapshots = [report?.lastHealth, report?.failureSnapshot?.sample, report?.postDrainSnapshot?.sample,
    ...(report?.healthHistory ?? [])].filter(Boolean);
  const peaks = [];
  for (const sample of snapshots) for (const [i, server] of (sample.servers ?? []).entries()) {
    if (Number.isFinite(server.peakPoolWaiting)) peaks[i] = Math.max(peaks[i] ?? 0, server.peakPoolWaiting);
  }
  return { passed: report?.localScenarioPassed === true, limits: report?.apiResourceLimits ?? null,
    replicas: report?.plan?.replicas ?? null, peakPoolWaitingByReplica: peaks,
    allocationP95Ms: report?.outcomes?.allocation?.p95Ms ?? null,
    notificationDeliveryP95Ms: report?.outcomes?.delivery?.p95Ms ?? null,
    pickedUp: report?.outcomes?.pickedUp ?? null, droppedOff: report?.outcomes?.droppedOff ?? null,
    requestsWithOffers: report?.outcomes?.requestsWithOffers ?? null };
}
function compareReports(before, after) {
  const blockers = [
    ...reportProblems(before).map(reason => `before:${reason}`),
    ...reportProblems(after).map(reason => `after:${reason}`),
  ];
  if (!isDeepStrictEqual(workload(before?.plan), workload(after?.plan))) blockers.push('different_workload_or_safety_limits');
  for (const key of ['sourceHash', 'apiImage', 'node', 'platform', 'architecture', 'workerSchedules', 'host'])
    if (!isDeepStrictEqual(before?.[key], after?.[key])) blockers.push(`different_${key}`);
  const comparable = blockers.length === 0;
  return { comparable, blockers, before: summary(before), after: summary(after),
    comparisonType: !comparable ? 'not-comparable' :
      isDeepStrictEqual(before?.apiResourceLimits, after?.apiResourceLimits) ? 'repeatability' : 'api_size',
    allocationP95DeltaMs: comparable && Number.isFinite(before?.outcomes?.allocation?.p95Ms) &&
      Number.isFinite(after?.outcomes?.allocation?.p95Ms) ? after.outcomes.allocation.p95Ms - before.outcomes.allocation.p95Ms : null,
    productionCapacityValidated: false, nextStageAuthorized: false,
    limitations: ['Single-host comparison only; generator separation is not implemented',
      'Repeat runs in alternating order; one comparison is not a causal performance or capacity certification'] };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args.some(arg => arg.startsWith('--')))
    throw new Error('Usage: node test/load/journeys/compare-reports.cjs BEFORE/report.json AFTER/report.json');
  const { readFileSync } = require('node:fs');
  const reports = args.map(path => JSON.parse(readFileSync(path, 'utf8')));
  const result = compareReports(...reports);
  console.log(JSON.stringify(result, null, 2));
  if (!result.comparable) process.exitCode = 1;
}
module.exports = { compareReports, reportProblems };
