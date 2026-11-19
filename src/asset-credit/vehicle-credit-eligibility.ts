import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

export const VEHICLE_CREDIT_RULE = 'Au moins un trajet terminé avec passager tous les deux jours, pendant au moins neuf mois.';
export function nineMonthsBefore(now: Date) {
  const date = new Date(now);
  const day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - 9);
  date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()));
  return date;
}

/** Persisted pickup/drop-off evidence, not account age or published empty trips.
 * This verifies recorded activity; it does not certify absence of collusion. */
export async function vehicleCreditEligibility(db: EntityManager | DataSource, driverId: string, now = new Date()) {
  const since = nineMonthsBefore(now);
  const [row] = await db.query(`WITH evidence AS (
    SELECT DISTINCT b."droppedOffAt" AT TIME ZONE 'UTC' AS at
    FROM trips t JOIN bookings b ON b."tripId"=t.id
    WHERE t."driverId"=$1 AND t.status='completed' AND b.status='completed'
      AND b."passengerId"<>t."driverId" AND b."pickedUp"=true AND b."droppedOff"=true
      AND b."pickedUpAt" IS NOT NULL AND b."droppedOffAt">b."pickedUpAt"
      AND b."droppedOffAt" AT TIME ZONE 'UTC'<=$3::timestamptz
  ), boundary AS (SELECT max(at) AS at FROM evidence WHERE at<=$2::timestamptz),
  points AS (SELECT at FROM evidence WHERE at>$2::timestamptz
    UNION SELECT at FROM boundary WHERE at IS NOT NULL UNION SELECT $3::timestamptz),
  gaps AS (SELECT at-lag(at) OVER(ORDER BY at) AS gap FROM points)
  SELECT (SELECT at FROM boundary) AS "activitySince",
    COALESCE((SELECT max(gap)<=interval '48 hours' FROM gaps),false)
      AND (SELECT at IS NOT NULL FROM boundary) AS eligible`, [driverId, since, now]);
  return { eligible: row?.eligible === true, requiredMonths: 9, maximumGapHours: 48,
    checkedAt: now.toISOString(), periodStart: since.toISOString(), rule: VEHICLE_CREDIT_RULE };
}
export async function assertVehicleCreditEligible(db: EntityManager | DataSource, driverId: string) {
  if (!(await vehicleCreditEligibility(db, driverId)).eligible)
    throw new ConflictException(`Véhicule à crédit : ${VEHICLE_CREDIT_RULE}`);
}
