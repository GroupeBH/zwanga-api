import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { StageFinancialRollout1780000056000 } from '../src/database/migrations/1780000056000-StageFinancialRollout';
import {
  activateFinancialRollout,
  assertLegacyRolloutSafe,
} from '../src/database/financial-rollout';

export function financialRolloutCases(
  getDb: () => DataSource,
  driver: string,
  trip: string,
) {
  describe('staged deployment after all-token cash migration', () => {
    beforeAll(async () => {
      const db = getDb();
      await db.query(
        'TRUNCATE notifications,wallet_ledger_entries,cash_commissions,driver_pro_trial_claims,welcome_bonus_grants,kyc_documents,subscriptions,bookings,trip_requests,trips,wallet_accounts,users',
      );
      await db.query(`ALTER TABLE users ADD COLUMN "fcmToken" text;
        CREATE TABLE driver_notification_clients ("userId" uuid PRIMARY KEY);
        CREATE TABLE app_update_clients ("userId" uuid PRIMARY KEY);
        CREATE UNIQUE INDEX "UQ_users_push_token" ON users ("fcmToken") WHERE "fcmToken" IS NOT NULL;`);
      const runner = db.createQueryRunner();
      try {
        await runner.startTransaction();
        await new StageFinancialRollout1780000056000().up(runner);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      } finally {
        await runner.release();
      }
    });
    // Test-only reset between cases. Production exposes one-way activation only.
    beforeEach(async () => {
      await getDb().query(
        'UPDATE financial_rollout SET enabled=false,"activatedAt"=NULL',
      );
    });
    const publish = (explicit = false) =>
      getDb().query(
        `INSERT INTO trips (id,"driverId","isPrivate","pricePerSeat","totalSeats","paymentModesExplicit")
      VALUES ($1,$2,false,30000,2,$3) RETURNING "acceptedPaymentModes"`,
        [randomUUID(), driver, explicit],
      );
    const noFunds = () =>
      getDb().query(
        'UPDATE wallet_accounts SET balance=0,"withdrawableBalance"=0 WHERE "userId"=$1',
        [driver],
      );

    it('prepares without enabling constraints or breaking an old cash acceptance/publication', async () => {
      await noFunds();
      expect((await publish())[0].acceptedPaymentModes).toContain('cash');
      const id = randomUUID();
      await getDb().query(
        `INSERT INTO bookings (id,"tripId","paymentAmount") VALUES ($1,$2,100000)`,
        [id, trip],
      );
      await getDb().query(`UPDATE bookings SET status='accepted' WHERE id=$1`, [
        id,
      ]);
      expect(
        await getDb().query('SELECT * FROM cash_commissions'),
      ).toHaveLength(0);
      expect(
        (
          await getDb().query(
            'SELECT "cashCommissionPolicyVersion" AS policy FROM bookings WHERE id=$1',
            [id],
          )
        )[0].policy,
      ).toBe(0);
      await expect(assertLegacyRolloutSafe(getDb())).resolves.toBeUndefined();
    });
    it('keeps accepted legacy rides commission-free after activation and upgrades pending ones', async () => {
      const accepted = randomUUID(),
        pending = randomUUID();
      await getDb().query(
        `INSERT INTO bookings (id,"tripId","paymentAmount",status) VALUES ($1,$3,10000,'accepted'),($2,$3,10000,'pending')`,
        [accepted, pending, trip],
      );
      await activateFinancialRollout(getDb());
      await getDb().query(
        `UPDATE bookings SET status='completed' WHERE id=$1`,
        [accepted],
      );
      await getDb().query(`UPDATE bookings SET status='accepted' WHERE id=$1`, [
        pending,
      ]);
      expect(
        await getDb().query('SELECT "bookingId" FROM cash_commissions'),
      ).toEqual([{ bookingId: pending }]);
    });
    it('does not create cash holds that could break an old wallet debit before activation', async () => {
      const id = randomUUID();
      await getDb().query(
        `INSERT INTO bookings (id,"tripId","paymentAmount",status) VALUES ($1,$2,10000,'accepted')`,
        [id, trip],
      );
      await expect(
        getDb().query(
          'UPDATE wallet_accounts SET balance=0,"withdrawableBalance"=0 WHERE "userId"=$1',
          [driver],
        ),
      ).resolves.toBeDefined();
      expect(
        await getDb().query('SELECT * FROM cash_commissions'),
      ).toHaveLength(0);
    });
    it('upgrades a pending legacy dispatch request at selection after activation', async () => {
      await noFunds();
      const id = randomUUID();
      await getDb().query(
        `INSERT INTO trip_requests (id,"paymentMode","numberOfSeats") VALUES ($1,'cash',2)`,
        [id],
      );
      await activateFinancialRollout(getDb());
      await expect(
        getDb().query(
          `UPDATE trip_requests SET status='driver_selected',"selectedDriverId"=$2,"selectedPricePerSeat"=30000 WHERE id=$1`,
          [id, driver],
        ),
      ).rejects.toThrow('CASH_COMMISSION_INSUFFICIENT');
    });
    it('preserves the 5% fee, mixed token origins and one-time capture after activation', async () => {
      await getDb().query(
        'UPDATE wallet_accounts SET balance=10,"withdrawableBalance"=0 WHERE "userId"=$1',
        [driver],
      );
      await activateFinancialRollout(getDb());
      const id = randomUUID();
      await getDb().query(
        `INSERT INTO bookings (id,"tripId","paymentAmount",status) VALUES ($1,$2,10000,'accepted')`,
        [id, trip],
      );
      await getDb().query(
        `UPDATE bookings SET status='completed' WHERE id=$1`,
        [id],
      );
      await getDb().query(
        `UPDATE bookings SET status='completed' WHERE id=$1`,
        [id],
      );
      expect(
        (
          await getDb().query(
            'SELECT balance,"withdrawableBalance" FROM wallet_accounts WHERE "userId"=$1',
            [driver],
          )
        )[0],
      ).toMatchObject({ balance: '5.00', withdrawableBalance: '0.00' });
      expect(
        await getDb().query(
          `SELECT * FROM wallet_ledger_entries WHERE type='cash_commission'`,
        ),
      ).toHaveLength(1);
    });
    it('keeps old publication usable without cash, but never changes an explicit cash choice', async () => {
      await noFunds();
      await activateFinancialRollout(getDb());
      expect((await publish())[0].acceptedPaymentModes).toEqual([
        'electronic',
        'points',
      ]);
      await expect(publish(true)).rejects.toThrow(
        'CASH_COMMISSION_INSUFFICIENT',
      );
    });
    it('checks capacity at acceptance even for a pending row created during the activation race', async () => {
      await noFunds();
      const id = randomUUID();
      await getDb().query(
        `INSERT INTO bookings (id,"tripId","paymentAmount") VALUES ($1,$2,100000)`,
        [id, trip],
      );
      // Simulate activation before the backfill sees a concurrent pending row.
      await getDb().query('UPDATE financial_rollout SET enabled=true');
      await expect(
        getDb().query(`UPDATE bookings SET status='accepted' WHERE id=$1`, [
          id,
        ]),
      ).rejects.toThrow('CASH_COMMISSION_INSUFFICIENT');
    });
    it('makes activation idempotent and refuses a legacy-server rollback afterward', async () => {
      await activateFinancialRollout(getDb());
      const original = await getDb().query('SELECT * FROM financial_rollout');
      await activateFinancialRollout(getDb());
      expect(await getDb().query('SELECT * FROM financial_rollout')).toEqual(
        original,
      );
      await expect(assertLegacyRolloutSafe(getDb())).rejects.toThrow(
        'already active',
      );
    });
    it('restores unique push ownership and removes ambiguous old registrations at activation', async () => {
      await getDb().query('DROP INDEX IF EXISTS "UQ_users_push_token"');
      await getDb().query(
        `INSERT INTO users (id,phone,"fcmToken") VALUES ($1,'synthetic-other','same-device')`,
        [randomUUID()],
      );
      await getDb().query(
        `UPDATE users SET "fcmToken"='same-device' WHERE id=$1`,
        [driver],
      );
      await activateFinancialRollout(getDb());
      expect(
        (
          await getDb().query(
            `SELECT count(*)::int AS total FROM users WHERE "fcmToken" IS NOT NULL`,
          )
        )[0].total,
      ).toBe(0);
      expect(
        (
          await getDb().query(
            `SELECT to_regclass('"UQ_users_push_token"') AS present`,
          )
        )[0].present,
      ).toBeTruthy();
    });
    it('preserves welcome credits and prevents duplicate bonuses across activation', async () => {
      await getDb().query(
        `INSERT INTO kyc_documents ("userId",status) VALUES ($1,'approved')`,
        [driver],
      );
      await activateFinancialRollout(getDb());
      await getDb().query('SELECT zwanga_backfill_welcome_bonus(100)');
      expect(
        await getDb().query('SELECT * FROM welcome_bonus_grants'),
      ).toHaveLength(1);
      expect(
        (
          await getDb().query(
            'SELECT balance FROM wallet_accounts WHERE "userId"=$1',
            [driver],
          )
        )[0].balance,
      ).toBe('150.00');
    });
  });
}
