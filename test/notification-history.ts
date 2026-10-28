import type { DataSource } from 'typeorm';

/** Synthetic history only, in the disposable dispatch cluster. No real tokens. */
export async function seedDispatchNotificationHistory(db: DataSource, userId: string, count = 211_000): Promise<void> {
  await db.query(`INSERT INTO notifications
    (id,"userId","fcmToken",title,body,data,status,"isActive","createdAt","updatedAt")
    SELECT md5('dispatch-history-notification-'||i)::uuid,$1,'fixture-history-token',
      'Synthetic history',repeat('Synthetic notification text. ',12),
      jsonb_build_object('tripRequestId',md5('history-request-'||i),
        'offerId',md5('history-offer-'||i),
        'type',(ARRAY['trip_request_nearby','driver_offer','payment_received','driver_dispatch_offer'])[1+(i%4)],
        'fixture',true),'sent',i%5<>0,now()-interval '30 days',now()-interval '30 days'
    FROM generate_series(1,$2::int) AS g(i)`, [userId, count]);
  await db.query('ANALYZE notifications');
}
