'use strict';

// Only the ride/alert workers; unrelated store, money and campaign crons remain disabled.
const WORKERS = Object.freeze([
  ['tracking/ride-progress.worker', 'RideProgressWorker', 'tick', 1000],
  ['trip-requests/dispatch/dispatch.service', 'DriverDispatchService', 'tick', 5000],
  ['trip-requests/dispatch/sequential-dispatch.service', 'SequentialDispatchService', 'deadlines', 1000],
  ['notifications/notifications.service', 'NotificationService', 'dispatchRealtimeNotifications', 2000],
  ['notifications/notifications.service', 'NotificationService', 'dispatchUrgentNotifications', 5000],
  ['notifications/notifications.service', 'NotificationService', 'dispatchTransactionalNotifications', 10000],
  ['notifications/notifications.service', 'NotificationService', 'recoverRideAcknowledgements', 5000],
  ['notifications/notifications.service', 'NotificationService', 'reconcileNearbyRequestRinging', 60000],
].map(([path, service, method, intervalMs]) => Object.freeze({ path, service, method, intervalMs })));
module.exports = { WORKERS };
