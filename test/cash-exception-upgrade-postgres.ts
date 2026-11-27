import { DataSource, QueryRunner } from 'typeorm';
import { UpgradeDriverCashExceptions1780000148000 } from '../src/database/migrations/1780000148000-UpgradeDriverCashExceptions';
import { readCashExceptionPolicy } from '../src/driver-finance/cash-exception-policy';

type Fixtures = {
  booking: (options?: { tripId?: string }) => Promise<string>;
  switchCash: (id: string) => Promise<unknown>;
  confirm: (id: string, occurrence: number) => Promise<unknown>;
  newTrip: () => Promise<string>;
};

/** Real SQL migration/receipt tests, under the existing isolated finance cluster.
 * Each schema downgrade/upgrade is rolled back, never run on an application DB.
 */
export function cashExceptionUpgradeCases(
  getDb: () => DataSource,
  driver: string,
  f: Fixtures,
) {
  describe('forward upgrade of the recorded per-booking schema', () => {
    const read = (q: QueryRunner, sql: string, params: unknown[] = []) =>
      q.query(sql, params) as Promise<Record<string, unknown>[]>;
    const migration = () => new UpgradeDriverCashExceptions1780000148000();
    const transaction = async (test: (q: QueryRunner) => Promise<void>) => {
      const q = getDb().createQueryRunner();
      await q.connect();
      await q.startTransaction();
      try {
        await test(q);
      } finally {
        await q.rollbackTransaction();
        await q.release();
      }
    };
    const legacy = async (q: QueryRunner) => {
      // Reproduce the old deployed columns and the check that rejects v2 receipts.
      await q.query(`ALTER TABLE driver_cash_exceptions
        ADD COLUMN occurrence integer CHECK(occurrence>0),
        ADD COLUMN "penaltyAmount" numeric(12,2) NOT NULL DEFAULT 0 CHECK("penaltyAmount" IN(0,3000)),
        ADD COLUMN "moneyPerToken" numeric(12,2) NOT NULL DEFAULT 10 CHECK("moneyPerToken">0),
        ADD COLUMN "chargedTokens" numeric(12,2) NOT NULL DEFAULT 0,
        ADD COLUMN "chargedWithdrawableTokens" numeric(12,2) NOT NULL DEFAULT 0;
        UPDATE driver_cash_exceptions e SET occurrence=i.occurrence,"penaltyAmount"=i."penaltyAmount",
          "moneyPerToken"=i."moneyPerToken","chargedTokens"=i."chargedTokens",
          "chargedWithdrawableTokens"=i."chargedWithdrawableTokens"
        FROM driver_cash_exception_trips i WHERE i."tripId"=e."tripId" AND e."confirmedAt" IS NOT NULL;
        ALTER TABLE driver_cash_exceptions ADD CHECK(
          ("confirmedAt" IS NULL AND occurrence IS NULL AND "penaltyAmount"=0) OR
          ("confirmedAt" IS NOT NULL AND occurrence IS NOT NULL AND
            "penaltyAmount"=CASE WHEN occurrence=1 THEN 0 ELSE 3000 END)),
          ADD CHECK("chargedTokens">=0 AND "chargedTokens"<=round("penaltyAmount"/"moneyPerToken",2)),
          ADD CHECK("chargedWithdrawableTokens">=0 AND "chargedWithdrawableTokens"<="chargedTokens");
        DROP TABLE driver_cash_exception_trips;
        DROP TABLE driver_cash_exception_rollout;`);
    };
    const snapshot = (q: QueryRunner) =>
      read(
        q,
        `SELECT
      (SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM wallet_accounts w) wallets,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM wallet_ledger_entries l) ledger,
      (SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM bookings b) bookings,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY "driverId") FROM driver_cash_restrictions r) restrictions,
      (SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM notifications n) notifications`,
      );
    const receipt = async (q: QueryRunner, id: string, occurrence: number) => {
      await q.query("SELECT set_config('zwanga.cash_exception_ack',$1,true)", [
        `${id}:${occurrence}`,
      ]);
      await q.query(
        `UPDATE bookings SET "cashReceivedAt"=now(),"cashReceivedAmount"="paymentAmount",
        "cashReceivedByDriverId"=$2 WHERE id=$1`,
        [id, driver],
      );
    };
    it('refuses non-transactional execution and destructive rollback', async () => {
      await expect(
        migration().up({ isTransactionActive: false } as QueryRunner),
      ).rejects.toThrow('transaction');
      await expect(migration().down()).rejects.toThrow('forward migration');
    });
    it('keeps an already-current schema, enabled gate and guard unchanged; supports a retry', async () => {
      await transaction(async (q) => {
        const before = await snapshot(q);
        const guard = await read(
          q,
          "SELECT pg_get_functiondef('zwanga_booking_cash_guard()'::regprocedure) AS definition",
        );
        await migration().up(q);
        await migration().up(q);
        expect(await snapshot(q)).toEqual(before);
        expect(
          await q.query('SELECT enabled FROM driver_cash_exception_rollout'),
        ).toEqual([{ enabled: true }]);
        expect(
          await q.query(
            "SELECT pg_get_functiondef('zwanga_booking_cash_guard()'::regprocedure) AS definition",
          ),
        ).toEqual(guard);
        expect(
          await q.query(
            "SELECT to_regclass('driver_cash_exceptions_legacy_1780000148000') AS archive",
          ),
        ).toEqual([{ archive: null }]);
      });
    });
    it('upgrades an empty old schema without enabling or collecting anything', async () => {
      await transaction(async (q) => {
        await legacy(q);
        const before = await snapshot(q);
        await migration().up(q);
        expect(await snapshot(q)).toEqual(before);
        expect(
          await q.query('SELECT * FROM driver_cash_exception_trips'),
        ).toEqual([]);
        expect(
          await q.query('SELECT enabled FROM driver_cash_exception_rollout'),
        ).toEqual([{ enabled: false }]);
        expect(
          await readCashExceptionPolicy(
            q as unknown as DataSource,
            driver,
            driver,
            true,
          ),
        ).toBeNull();
      });
    });
    it('preserves a pending authorization and permits its acknowledged receipt after upgrade', async () => {
      const id = await f.booking();
      await f.switchCash(id);
      await transaction(async (q) => {
        await legacy(q);
        const before = await snapshot(q);
        await migration().up(q);
        expect(await snapshot(q)).toEqual(before);
        expect(
          (
            await readCashExceptionPolicy(
              q as unknown as DataSource,
              driver,
              id,
              true,
            )
          )?.notice.occurrence,
        ).toBe(1);
        await receipt(q, id, 1);
        expect(
          await q.query(
            'SELECT occurrence,"penaltyAmount" FROM driver_cash_exception_trips',
          ),
        ).toEqual([{ occurrence: 1, penaltyAmount: '0.00' }]);
        expect(
          (
            await read(
              q,
              'SELECT "confirmedAt" FROM driver_cash_exceptions WHERE "bookingId"=$1',
              [id],
            )
          )[0].confirmedAt,
        ).not.toBeNull();
        expect(
          (
            await read(
              q,
              'SELECT "confirmedAt" FROM driver_cash_exceptions_legacy_1780000148000 WHERE "bookingId"=$1',
              [id],
            )
          )[0].confirmedAt,
        ).toBeNull();
      });
    });
    it('preserves paid and unpaid historical penalties; another passenger does not incur a second penalty', async () => {
      const first = await f.booking();
      await f.switchCash(first);
      await f.confirm(first, 1);
      const repeatTrip = await f.newTrip();
      const repeat = await f.booking({ tripId: repeatTrip });
      await f.switchCash(repeat);
      await f.confirm(repeat, 2);
      await getDb().query(
        'UPDATE wallet_accounts SET balance=40 WHERE "userId"=$1',
        [driver],
      );
      await getDb().query('SELECT zwanga_cash_exception_collect($1)', [driver]);
      const other = await f.booking({ tripId: repeatTrip });
      await f.switchCash(other);
      await transaction(async (q) => {
        const incidents = await read(
          q,
          'SELECT * FROM driver_cash_exception_trips ORDER BY occurrence',
        );
        expect(Number(incidents[1].chargedTokens)).toBeGreaterThan(0);
        expect(Number(incidents[1].chargedTokens)).toBeLessThan(300);
        await legacy(q);
        const before = await snapshot(q);
        await migration().up(q);
        expect(await snapshot(q)).toEqual(before);
        expect(
          await q.query(
            'SELECT * FROM driver_cash_exception_trips ORDER BY occurrence',
          ),
        ).toEqual(incidents);
        expect(
          (
            await readCashExceptionPolicy(
              q as unknown as DataSource,
              driver,
              other,
              true,
            )
          )?.notice,
        ).toMatchObject({
          occurrence: 2,
          penaltyAmount: 0,
          alreadyCountedForTrip: true,
        });
        await receipt(q, other, 2);
        expect(
          await q.query(
            'SELECT * FROM driver_cash_exception_trips ORDER BY occurrence',
          ),
        ).toEqual(incidents);
      });
    });
    it('retains an existing restriction, without deactivating a user during migration', async () => {
      for (let n = 1; n <= 4; n++) {
        const id = await f.booking({ tripId: await f.newTrip() });
        await f.switchCash(id);
        await f.confirm(id, n);
      }
      await transaction(async (q) => {
        await legacy(q);
        const before = await snapshot(q);
        await migration().up(q);
        expect(await snapshot(q)).toEqual(before);
        expect(
          await q.query('SELECT "isActive" FROM users WHERE id=$1', [driver]),
        ).toEqual([{ isActive: true }]);
        expect(
          await q.query('SELECT * FROM driver_cash_restrictions'),
        ).toHaveLength(1);
      });
    });
    it('refuses duplicate historical incidents on one trip instead of charging or forgiving money', async () => {
      const one = await f.booking(),
        two = await f.booking();
      await f.switchCash(one);
      await f.switchCash(two);
      await f.confirm(one, 1);
      await f.confirm(two, 1);
      await transaction(async (q) => {
        await legacy(q);
        await q.query(
          'UPDATE driver_cash_exceptions SET occurrence=2,"penaltyAmount"=3000 WHERE "bookingId"=$1',
          [two],
        );
        const before = await snapshot(q);
        await expect(migration().up(q)).rejects.toThrow(
          'CASH_UPGRADE_RECONCILIATION_REQUIRED',
        );
        expect(await snapshot(q)).toEqual(before);
        expect(
          await q.query(
            "SELECT to_regclass('driver_cash_exception_trips') AS target",
          ),
        ).toEqual([{ target: null }]);
      });
    });
    it('rejects a half-upgraded schema without changing balances', async () => {
      await transaction(async (q) => {
        await q.query('DROP TABLE driver_cash_exception_rollout');
        const before = await snapshot(q);
        await expect(migration().up(q)).rejects.toThrow(
          'CASH_UPGRADE_UNEXPECTED_SCHEMA',
        );
        expect(await snapshot(q)).toEqual(before);
      });
    });
    it('rolls back DDL and archival when a required trigger is missing', async () => {
      await transaction(async (q) => {
        await legacy(q);
        await q.query('DROP TRIGGER cash_exception_release ON bookings');
        await q.query('SAVEPOINT upgrade_test');
        await expect(migration().up(q)).rejects.toThrow(
          'CASH_UPGRADE_TRIGGER_MISMATCH',
        );
        await q.query('ROLLBACK TO SAVEPOINT upgrade_test');
        expect(
          await q.query(
            "SELECT to_regclass('driver_cash_exception_trips') AS target, to_regclass('driver_cash_exceptions_legacy_1780000148000') AS archive",
          ),
        ).toEqual([{ target: null, archive: null }]);
      });
    });
  });
}
