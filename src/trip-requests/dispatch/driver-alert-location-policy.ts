import { ONGOING_DRIVER_POSITION_TIME_SQL, USABLE_DRIVER_LOCATION_SQL } from './driver-location-policy';

/** New request alerts only. Stored locations, request browsing and ongoing rides keep their policies. */
export const DRIVER_ALERT_LOCATION_MAX_AGE_HOURS = 48;

/** Internal SQL expressions, never client input. Preserve the GPS ingestion clock-skew tolerance. */
export const driverAlertLocationTimeSql = (timestamp: string) => `(${timestamp} > now() - interval '${DRIVER_ALERT_LOCATION_MAX_AGE_HOURS} hours'
  AND ${timestamp} <= now() + interval '5 seconds')`;

export const PRESENCE_ALERT_LOCATION_SQL = `${USABLE_DRIVER_LOCATION_SQL}
  AND ${driverAlertLocationTimeSql('p."updatedAt"')}`;
export const ONGOING_ALERT_LOCATION_SQL = driverAlertLocationTimeSql(ONGOING_DRIVER_POSITION_TIME_SQL);
