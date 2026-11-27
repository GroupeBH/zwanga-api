'use strict';
function replicaApplicationName(index) {
  if (!Number.isInteger(index) || index < 0 || index >= 32) throw new Error('Invalid local replica index');
  return `zwanga-journey-api-${index + 1}`;
}
function replicaFromApplicationName(name) {
  if (name === 'zwanga-journey-api') return 'legacy';
  const match = /^zwanga-journey-api-([1-9]|[12][0-9]|3[0-2])$/.exec(name ?? '');
  return match ? Number(match[1]) : 'unknown';
}
const API_APPLICATION_FILTER = "application_name ~ '^zwanga-journey-api(-([1-9]|[12][0-9]|3[0-2]))?$'";
module.exports = { replicaApplicationName, replicaFromApplicationName, API_APPLICATION_FILTER };
