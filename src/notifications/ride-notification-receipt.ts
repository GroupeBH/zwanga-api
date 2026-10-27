import type { EntityManager } from 'typeorm';

export type RideReceiptDetail = { observedAt?: string; source?: 'native' | 'javascript'; failureCode?: string };

/** A client reports reception/display, never audible output or a business decision. */
export async function recordRideNotificationReceipt(
  manager: EntityManager,
  userId: string,
  notificationId: string,
  stage: 'received' | 'displayed' = 'received',
  detail?: RideReceiptDetail,
): Promise<{ received: boolean }> {
  const rows: { notificationId: string }[] = await manager.query(
    `
    INSERT INTO ride_notification_receipts ("notificationId", "displayedAt", "clientObservedAt", source, "failureCode")
    SELECT id, CASE WHEN $3 = 'displayed' THEN clock_timestamp() ELSE NULL END,
      CASE WHEN $4::timestamptz BETWEEN now() - interval '7 days' AND now() + interval '5 minutes' THEN $4::timestamptz END, $5, $6
    FROM notifications WHERE id = $1 AND "userId" = $2
      AND data ->> 'type' IN ('new_booking','driver_dispatch_offer','trip_request_nearby')
    ON CONFLICT ("notificationId") DO UPDATE SET "displayedAt" =
      COALESCE(ride_notification_receipts."displayedAt", EXCLUDED."displayedAt"),
      "clientObservedAt" = COALESCE(ride_notification_receipts."clientObservedAt", EXCLUDED."clientObservedAt"),
      source = COALESCE(ride_notification_receipts.source, EXCLUDED.source),
      "failureCode" = COALESCE(EXCLUDED."failureCode", ride_notification_receipts."failureCode")
    RETURNING "notificationId"`,
    [notificationId, userId, stage, detail?.observedAt ?? null, detail?.source ?? null, detail?.failureCode ?? null],
  );
  return { received: rows.length > 0 };
}
