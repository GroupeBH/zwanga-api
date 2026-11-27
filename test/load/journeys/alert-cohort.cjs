'use strict';

// Snapshot committed offer IDs while realtime listeners are still observing.
// Creation timestamps alone cannot distinguish transactions committed later.
// IDs remain in memory; only aggregate counters enter the private report.
async function captureAlertCohort(db) {
  return db.query(`SELECT o.id AS "offerId", n.id AS "notificationId",
    (o.status <> 'pending' OR o."expiresAt" <= statement_timestamp() OR n."isActive" = false) AS obsolete
    FROM trip_request_dispatch_offers o
    LEFT JOIN notifications n ON n."eventKey" = 'sequential-offer:' || o.id::text`);
}

// Take the final business-state snapshot BEFORE stopping the listeners. A later
// expiry must not turn an undelivered, live invitation into a successful test.
async function closeAlertCohort(db, rows) {
  if (!rows.length) return rows;
  const states = await db.query(`SELECT id, status FROM trip_request_dispatch_offers
    WHERE id = ANY($1::uuid[])`, [rows.map(row => row.offerId)]);
  const byId = new Map(states.map(row => [row.id, row.status]));
  return rows.map(row => ({ ...row, closingStatus: byId.get(row.offerId) }));
}

function summarizeAlertCohort(rows, observed, confirmed, finalOffers) {
  const capturedNotifications = new Set(rows.map(r => r.notificationId).filter(Boolean));
  const result = { capturedOffers: rows.length, notificationsMissing: 0,
    observedWithinCohort: 0, confirmedWithinCohort: 0, observedWithoutConfirmation: 0,
    unobservedObsolete: 0, unobservedWithdrawnDuringObservation: 0,
    unobservedNonObsolete: 0, confirmedWithoutObservation: 0,
    observedOutsideCohort: [...observed].filter(id => !capturedNotifications.has(id)).length,
    offersCreatedAfterCapture: finalOffers - rows.length };
  for (const row of rows) {
    const id = row.notificationId;
    if (!id) { result.notificationsMissing++; continue; }
    if (confirmed.has(id)) result.confirmedWithinCohort++;
    if (observed.has(id)) {
      result.observedWithinCohort++;
      if (!confirmed.has(id)) result.observedWithoutConfirmation++;
    } else {
      if (row.obsolete === true) result.unobservedObsolete++;
      else if (['cancelled', 'accepted', 'declined'].includes(row.closingStatus))
        result.unobservedWithdrawnDuringObservation++;
      else result.unobservedNonObsolete++;
      if (confirmed.has(id)) result.confirmedWithoutObservation++;
    }
  }
  return result;
}

function checkAlertCohort(result) {
  for (const key of ['notificationsMissing', 'observedWithoutConfirmation',
    'unobservedNonObsolete', 'confirmedWithoutObservation']) {
    if (result?.[key] !== 0) throw new Error(`Alert cohort gate failed: ${key}`);
  }
}

async function reconcileAlertCohort(db, rows, observed, finalOffers) {
  const ids = rows.map(r => r.notificationId).filter(Boolean);
  const receipts = ids.length ? await db.query(`SELECT "notificationId" FROM ride_notification_receipts
    WHERE "notificationId" = ANY($1::uuid[])`, [ids]) : [];
  return summarizeAlertCohort(rows, observed, new Set(receipts.map(r => r.notificationId)), finalOffers);
}

module.exports = { captureAlertCohort, closeAlertCohort, summarizeAlertCohort, reconcileAlertCohort, checkAlertCohort };
