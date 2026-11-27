'use strict';
function profiledTables(db) {
  return [...db.entityMetadatas.map(m => m.tableName), 'ride_progress_jobs', 'trip_request_dispatch_offers',
    'driver_dispatch_presence', 'ride_notification_receipts', 'driver_notification_clients',
    'trip_request_driver_queue', 'trip_request_driver_refusals', 'nearby_driver_ring_state',
    'nearby_driver_ring_events', 'ride_notification_retries', 'maintenance_job_leases'];
}
module.exports = { profiledTables };
