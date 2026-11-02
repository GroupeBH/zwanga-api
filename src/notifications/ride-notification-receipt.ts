import type { EntityManager } from 'typeorm';

export const AUDIO_RECEIPT_STAGES = ['audio_started', 'audio_failed', 'audio_suppressed'] as const;
export const AUDIO_RECEIPT_REASONS = ['PLAYER_STARTED', 'PLAYER_ERROR', 'AUDIO_FOCUS_DENIED', 'DEVICE_POLICY', 'BACKGROUND_START_DENIED', 'NOTIFICATIONS_DISABLED'] as const;
export type RideReceiptDetail = { observedAt?: string; source?: 'native' | 'javascript'; failureCode?: string;
  audioStage?: typeof AUDIO_RECEIPT_STAGES[number]; audioObservedAt?: string; audioReason?: typeof AUDIO_RECEIPT_REASONS[number] };

/** Telemetry reports player state, never proof of hearing or a business decision. */
export async function recordRideNotificationReceipt(
  manager: EntityManager,
  userId: string,
  notificationId: string,
  stage: 'received' | 'displayed' = 'received',
  detail?: RideReceiptDetail,
): Promise<{ received: boolean }> {
  const rows: { notificationId: string }[] = await manager.query(
    `
    INSERT INTO ride_notification_receipts ("notificationId", "displayedAt", "clientObservedAt", source, "failureCode", "audioEvents")
    SELECT id, CASE WHEN $3 = 'displayed' THEN clock_timestamp() ELSE NULL END,
      CASE WHEN $4::timestamptz BETWEEN now() - interval '7 days' AND now() + interval '5 minutes' THEN $4::timestamptz END, $5, $6,
      CASE WHEN $7::text IS NOT NULL THEN jsonb_build_object($7::text, jsonb_build_object(
        'recordedAt', clock_timestamp(), 'observedAt', CASE WHEN $8::timestamptz BETWEEN now() - interval '7 days' AND now() + interval '5 minutes' THEN $8::timestamptz END,
        'reason', $9::text)) ELSE '{}'::jsonb END
    FROM notifications WHERE id = $1 AND "userId" = $2
      AND data ->> 'type' IN ('new_booking','driver_dispatch_offer','trip_request_nearby')
    ON CONFLICT ("notificationId") DO UPDATE SET "displayedAt" =
      COALESCE(ride_notification_receipts."displayedAt", EXCLUDED."displayedAt"),
      "clientObservedAt" = COALESCE(ride_notification_receipts."clientObservedAt", EXCLUDED."clientObservedAt"),
      source = COALESCE(ride_notification_receipts.source, EXCLUDED.source),
      "failureCode" = COALESCE(EXCLUDED."failureCode", ride_notification_receipts."failureCode"),
      "audioEvents" = EXCLUDED."audioEvents" || ride_notification_receipts."audioEvents"
    RETURNING "notificationId"`,
    [notificationId, userId, stage, detail?.observedAt ?? null, detail?.source ?? null, detail?.failureCode ?? null,
      AUDIO_RECEIPT_STAGES.includes(detail?.audioStage as any) ? detail!.audioStage : null,
      detail?.audioObservedAt ?? null, AUDIO_RECEIPT_REASONS.includes(detail?.audioReason as any) ? detail!.audioReason : null],
  );
  return { received: rows.length > 0 };
}
