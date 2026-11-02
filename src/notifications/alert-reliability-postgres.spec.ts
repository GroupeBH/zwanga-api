import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { AlertDeliveryReliability1780000106000 } from '../database/migrations/1780000106000-AlertDeliveryReliability';
import { RideNotificationReceipts1780000093000 } from '../database/migrations/1780000093000-RideNotificationReceipts';
import { recordRideNotificationReceipt } from './ride-notification-receipt';
import { PUSH_RETRY_ELIGIBLE_SQL } from './push-retry-policy';
import { validate } from 'class-validator';
import { NotificationReceiptDto } from '../trip-requests/dispatch/dispatch.dto';

const bin = process.env.NOTIFICATIONS_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'alert retry and audio telemetry on isolated PostgreSQL',
  () => {
    let fixture: IsolatedPostgres, db: DataSource;
    const user = randomUUID(),
      id = randomUUID();
    const migration = new AlertDeliveryReliability1780000106000();
    const change = (direction: 'up' | 'down') =>
      db.transaction((manager) => migration[direction](manager.queryRunner!));
    beforeAll(async () => {
      fixture = new IsolatedPostgres(bin!);
      db = await fixture.start();
      await db.query(`CREATE TABLE users (id uuid PRIMARY KEY, "fcmToken" text);
      CREATE TABLE notifications (id uuid PRIMARY KEY, "userId" varchar, "fcmToken" text, data jsonb);
      INSERT INTO users VALUES ('${user}', 'token-a');
      INSERT INTO notifications VALUES ('${id}', '${user}', 'token-a', '{"type":"driver_dispatch_offer"}');`);
      const runner = db.createQueryRunner();
      try {
        await new RideNotificationReceipts1780000093000().up(runner);
      } finally {
        await runner.release();
      }
      await db.query(
        'ALTER TABLE ride_notification_receipts ADD COLUMN "clientObservedAt" timestamptz, ADD COLUMN source text, ADD COLUMN "failureCode" text',
      );
      await change('up');
    }, 90000);
    afterAll(async () => {
      await fixture?.stop();
    });
    beforeEach(async () => {
      await db.query('TRUNCATE ride_notification_receipts');
      await db.query(
        `UPDATE notifications SET "pushRetryAt"=NULL,"pushPermanentFailure"=false,"pushAttempts"=0`,
      );
      await db.query(`UPDATE users SET "fcmToken"='token-a'`);
    });
    const eligible = () =>
      db.query(
        `SELECT id FROM notifications notification WHERE ${PUSH_RETRY_ELIGIBLE_SQL}`,
      );
    it('does not reclaim a Retry-After before its deadline, including after a worker restart', async () => {
      await db.query(
        `UPDATE notifications SET "pushRetryAt"=now()+interval '120 seconds', "pushAttempts"=1`,
      );
      expect(await eligible()).toHaveLength(0);
      await db.query(
        `UPDATE notifications SET "pushRetryAt"=now()-interval '1 second'`,
      );
      expect(await eligible()).toHaveLength(1);
    });
    it('permits a permanent-token failure only after a meaningful token change', async () => {
      await db.query(`UPDATE notifications SET "pushPermanentFailure"=true`);
      expect(await eligible()).toHaveLength(0);
      await db.query(`UPDATE users SET "fcmToken"=NULL`);
      expect(await eligible()).toHaveLength(0);
      await db.query(`UPDATE users SET "fcmToken"='token-b'`);
      expect(await eligible()).toHaveLength(1);
    });
    it('keeps three bounded first observations, separates device/server times and rejects foreign accounts', async () => {
      const detail = {
        source: 'native' as const,
        audioStage: 'audio_started' as const,
        audioReason: 'PLAYER_STARTED' as const,
        audioObservedAt: new Date(Date.now() - 10000).toISOString(),
      };
      expect(
        await recordRideNotificationReceipt(
          db.manager,
          randomUUID(),
          id,
          'received',
          detail,
        ),
      ).toEqual({ received: false });
      await recordRideNotificationReceipt(
        db.manager,
        user,
        id,
        'displayed',
        detail,
      );
      await recordRideNotificationReceipt(db.manager, user, id, 'displayed', {
        ...detail,
        audioObservedAt: new Date().toISOString(),
      });
      for (const audioStage of ['audio_failed', 'audio_suppressed'] as const)
        await recordRideNotificationReceipt(db.manager, user, id, 'displayed', {
          ...detail,
          audioStage,
          audioObservedAt: '2099-01-01T00:00:00Z',
        });
      const [row] = await db.query('SELECT * FROM ride_notification_receipts');
      expect(Object.keys(row.audioEvents)).toHaveLength(3);
      expect(Date.parse(row.audioEvents.audio_started.observedAt)).toBe(
        Date.parse(detail.audioObservedAt),
      );
      expect(
        Date.parse(row.audioEvents.audio_started.recordedAt),
      ).toBeGreaterThan(Date.parse(detail.audioObservedAt));
      expect(row.audioEvents.audio_failed.observedAt).toBeNull();
      expect(row.displayedAt).toBeInstanceOf(Date);
      expect(
        await validate(
          Object.assign(new NotificationReceiptDto(), {
            stage: 'displayed',
            ...detail,
          }),
        ),
      ).toHaveLength(0);
      expect(
        (
          await validate(
            Object.assign(new NotificationReceiptDto(), {
              audioStage: 'arbitrary',
              audioReason: 'secret',
            }),
          )
        ).length,
      ).toBe(2);
    });
    it('rolls back and reapplies without changing existing notification rows', async () => {
      await change('down');
      expect(await db.query('SELECT id FROM notifications')).toEqual([{ id }]);
      await change('up');
      expect(await eligible()).toHaveLength(1);
    });
  },
);
