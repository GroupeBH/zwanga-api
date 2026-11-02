import type { EntityManager } from 'typeorm';
import type { RecurringTripTemplate } from './entities/recurring-trip-template.entity';
import { enqueueTransactionalNotification } from '../notifications/transactional-notification';

/** Recheck the vehicle and template revision before pausing; a concurrent repair
 * or another scheduler must not be overwritten or generate a duplicate push. */
export async function pauseUnavailableRecurring(manager: EntityManager, template: RecurringTripTemplate): Promise<boolean> {
  return manager.transaction(async tx => {
    await tx.query("SET LOCAL lock_timeout='2s'");
    await tx.query("SET LOCAL statement_timeout='5s'");
    // TypeORM exposes Dates at millisecond precision; PostgreSQL defaults may
    // contain microseconds. Compare at the precision of the captured revision.
    const rows = await tx.query(`WITH paused AS (
      UPDATE recurring_trip_templates r SET status='paused', "updatedAt"=clock_timestamp()
      WHERE id=$1 AND status='active' AND "vehicleId"=$2
        AND date_trunc('milliseconds', "updatedAt")=$3::timestamp
        AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.id::text=r."vehicleId"::text
          AND v."ownerId"::text=r."driverId"::text AND v."isActive"=true)
      RETURNING id) SELECT id FROM paused`, [template.id, template.vehicleId, template.updatedAt]);
    if (!rows.length) return false;
    await enqueueTransactionalNotification(tx, { userId: template.driverId,
      eventKey: `recurring-unavailable:${template.id}:${template.updatedAt.toISOString()}`,
      title: 'Trajet récurrent en pause',
      body: 'Votre véhicule est indisponible. Vérifiez-le puis reprenez votre trajet récurrent.',
      data: { type: 'recurring_trip_paused', recurringTemplateId: template.id } });
    return true;
  });
}
