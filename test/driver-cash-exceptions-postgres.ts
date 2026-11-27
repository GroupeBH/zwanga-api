import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { DriverCashExceptions1780000145000 } from '../src/database/migrations/1780000145000-DriverCashExceptions';
import { readCashExceptionPolicy } from '../src/driver-finance/cash-exception-policy';
import { cashExceptionUpgradeCases } from './cash-exception-upgrade-postgres';

export function driverCashExceptionCases(
  getDb: () => DataSource,
  driver: string,
  trip: string,
) {
  describe('prospective driver cash exceptions, actual commission/wallet triggers', () => {
    const query = (sql: string, params: unknown[] = []) =>
      getDb().query<Record<string, unknown>[]>(sql, params);
    beforeAll(async () => {
      await query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS status text DEFAULT 'upcoming';
        CREATE TABLE driver_offers(id uuid PRIMARY KEY, "driverId" uuid REFERENCES users(id), status text DEFAULT 'pending');`);
      await getDb().transaction((m) =>
        new DriverCashExceptions1780000145000().up(m.queryRunner!),
      );
    });
    beforeEach(async () => {
      await query('UPDATE financial_rollout SET enabled=true');
      await query('UPDATE driver_cash_exception_rollout SET enabled=true');
      await query(
        'UPDATE wallet_accounts SET balance=0,"withdrawableBalance"=0 WHERE "userId"=$1',
        [driver],
      );
      // Exhaust the existing six-trip allowance. These are not violations.
      for (let n = 0; n < 6; n++)
        await query(
          `INSERT INTO driver_cash_credit_trips("driverId","journeyId",state) VALUES($1,$2,'consumed')`,
          [driver, randomUUID()],
        );
      await query(
        `UPDATE trips SET "acceptedPaymentModes"=ARRAY['points','electronic'] WHERE id=$1`,
        [trip],
      );
    });
    const newTrip = async () => {
      const id = randomUUID();
      await query(
        `INSERT INTO trips(id,"driverId","acceptedPaymentModes") VALUES($1,$2,ARRAY['points','electronic'])`,
        [id, driver],
      );
      return id;
    };
    const booking = async (
      overrides: {
        amount?: number;
        status?: string;
        arrived?: boolean;
        tripId?: string;
      } = {},
    ) => {
      const id = randomUUID();
      await query(
        `INSERT INTO bookings(id,"tripId","passengerId","paymentAmount","paymentMode","paymentStatus",status,"pickedUp","droppedOff","cashCommissionTokenValue","cashCommissionPolicyVersion")
        VALUES($1,$2,$3,$4,'points','pending',$5,true,$6,10,2)`,
        [
          id,
          overrides.tripId ?? trip,
          randomUUID(),
          overrides.amount ?? 1000,
          overrides.status ?? 'completed',
          overrides.arrived ?? true,
        ],
      );
      return id;
    };
    const switchCash = (id: string) =>
      query(
        `UPDATE bookings SET "paymentMode"='cash',"paymentStatus"='not_required' WHERE id=$1`,
        [id],
      );
    const confirm = (id: string, occurrence?: number) =>
      getDb().transaction(async (m) => {
        if (occurrence)
          await m.query(
            "SELECT set_config('zwanga.cash_exception_ack',$1,true)",
            [`${id}:${occurrence}`],
          );
        await m.query(
          `UPDATE bookings SET "cashReceivedAt"=COALESCE("cashReceivedAt",now()),
        "cashReceivedAmount"="paymentAmount","cashReceivedByDriverId"=$2 WHERE id=$1`,
          [id, driver],
        );
      });
    const incident = async (id: string) =>
      (
        await query(
          `SELECT i.occurrence,COALESCE(i."penaltyAmount",0)::numeric(12,2) AS "penaltyAmount",
            i."chargedTokens",i."chargedWithdrawableTokens",e.*
            FROM driver_cash_exceptions e LEFT JOIN driver_cash_exception_trips i ON i."tripId"=e."tripId"
            WHERE e."bookingId"=$1`,
          [id],
        )
      )[0];
    it('first exception warns on receipt only; commission remains due; retries do not consume it twice', async () => {
      const id = await booking();
      await switchCash(id);
      await switchCash(id);
      expect(await incident(id)).toMatchObject({
        occurrence: null,
        penaltyAmount: '0.00',
      });
      expect(
        (
          await query('SELECT * FROM cash_commissions WHERE "bookingId"=$1', [
            id,
          ])
        )[0],
      ).toMatchObject({ commissionAmount: '50.00', debtTokens: '5.00' });
      await expect(confirm(id)).rejects.toThrow('CASH_EXCEPTION_ACK_REQUIRED');
      expect(
        (
          await query('SELECT "cashReceivedAt" FROM bookings WHERE id=$1', [id])
        )[0].cashReceivedAt,
      ).toBeNull();
      await confirm(id, 1);
      await confirm(id, 1);
      expect(await incident(id)).toMatchObject({
        occurrence: 1,
        penaltyAmount: '0.00',
      });
      expect(
        await query(
          "SELECT * FROM notifications WHERE data->>'type'='cash_exception_warning'",
        ),
      ).toHaveLength(1);
      expect(
        (await query('SELECT * FROM users WHERE id=$1', [driver]))[0].isActive,
      ).toBe(true);
    });
    it('two simultaneous receipts on different trips require a fresh warning for the repeat', async () => {
      const one = await booking(),
        two = await booking({ tripId: await newTrip() });
      await switchCash(one);
      await switchCash(two);
      const results = await Promise.allSettled([
        confirm(one, 1),
        confirm(two, 1),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const next = (await incident(one)).occurrence ? two : one;
      await confirm(next, 2);
      expect(await incident(next)).toMatchObject({
        occurrence: 2,
        penaltyAmount: '3000.00',
        chargedTokens: '0.00',
      });
      expect(
        (
          await query(
            'SELECT SUM("commissionAmount") AS total FROM cash_commissions',
          )
        )[0].total,
      ).toBe('100.00');
      expect(
        (
          await query('SELECT "paymentAmount" FROM bookings WHERE id=$1', [
            next,
          ])
        )[0].paymentAmount,
      ).toBe('1000.00');
    });
    it('simultaneous passenger receipts on one trip count only once and charge each commission', async () => {
      const one = await booking(),
        two = await booking();
      await switchCash(one);
      await switchCash(two);
      await Promise.all([confirm(one, 1), confirm(two, 1)]);
      expect(
        await query('SELECT * FROM driver_cash_exception_trips'),
      ).toHaveLength(1);
      expect(await incident(one)).toMatchObject({
        occurrence: 1,
        penaltyAmount: '0.00',
      });
      expect(await incident(two)).toMatchObject({
        occurrence: 1,
        penaltyAmount: '0.00',
      });
      expect(
        (
          await query(
            'SELECT SUM("commissionAmount") AS total FROM cash_commissions',
          )
        )[0].total,
      ).toBe('100.00');
      expect(
        await query(
          "SELECT * FROM notifications WHERE data->>'type'='cash_exception_warning'",
        ),
      ).toHaveLength(1);
    });
    it('multiple passengers on a repeat trip share one penalty, even when another trip is confirmed between receipts', async () => {
      const warning = await booking();
      await switchCash(warning);
      await confirm(warning, 1);
      const repeatTrip = await newTrip();
      const one = await booking({ tripId: repeatTrip }),
        two = await booking({ tripId: repeatTrip });
      await switchCash(one);
      await switchCash(two);
      await confirm(one, 2);
      const another = await booking({ tripId: await newTrip() });
      await switchCash(another);
      await confirm(another, 3);
      const policy = await readCashExceptionPolicy(getDb(), driver, two, true);
      expect(policy?.notice).toMatchObject({
        occurrence: 2,
        penaltyAmount: 0,
        alreadyCountedForTrip: true,
      });
      expect(policy?.notice.message).toContain('aucune nouvelle pénalité');
      await confirm(two, 2);
      expect(
        await query('SELECT * FROM driver_cash_exception_trips'),
      ).toHaveLength(3);
      expect(
        (
          await query(
            'SELECT SUM("penaltyAmount") AS total FROM driver_cash_exception_trips',
          )
        )[0].total,
      ).toBe('6000.00');
      expect(
        await query('SELECT * FROM driver_cash_restrictions'),
      ).toHaveLength(0);
      expect(
        await query(
          "SELECT * FROM notifications WHERE data->>'type'='cash_exception_warning'",
        ),
      ).toHaveLength(3);
    });
    it('four passengers on a single trip cannot trigger the fourth-incident restriction', async () => {
      for (let n = 0; n < 4; n++) {
        const id = await booking();
        await switchCash(id);
        await confirm(id, 1);
      }
      expect(
        await query('SELECT * FROM driver_cash_exception_trips'),
      ).toHaveLength(1);
      expect(
        await query('SELECT * FROM driver_cash_restrictions'),
      ).toHaveLength(0);
    });
    it('concurrent receipts on a repeat trip create one fee, with the original passenger amounts unchanged', async () => {
      const warning = await booking();
      await switchCash(warning);
      await confirm(warning, 1);
      const tid = await newTrip(),
        one = await booking({ tripId: tid }),
        two = await booking({ tripId: tid });
      await switchCash(one);
      await switchCash(two);
      await query(
        'UPDATE wallet_accounts SET balance=400,"withdrawableBalance"=400 WHERE "userId"=$1',
        [driver],
      );
      await Promise.all([confirm(one, 2), confirm(two, 2)]);
      expect(
        await query('SELECT * FROM driver_cash_exception_trips'),
      ).toHaveLength(2);
      expect(await incident(two)).toMatchObject({
        occurrence: 2,
        penaltyAmount: '3000.00',
        chargedTokens: '300.00',
      });
      expect(
        await query(
          "SELECT * FROM wallet_ledger_entries WHERE type='cash_penalty'",
        ),
      ).toHaveLength(1);
      expect(
        (
          await query('SELECT balance FROM wallet_accounts WHERE "userId"=$1', [
            driver,
          ])
        )[0].balance,
      ).toBe('85.00');
      expect(
        (
          await query(
            'SELECT SUM("paymentAmount") AS total FROM bookings WHERE "tripId"=$1',
            [tid],
          )
        )[0].total,
      ).toBe('2000.00');
    });
    it('releasing one unconfirmed authorization preserves the other passengers and the trip incident', async () => {
      const one = await booking(),
        two = await booking(),
        three = await booking();
      await switchCash(one);
      await switchCash(two);
      await switchCash(three);
      await query(
        `UPDATE bookings SET "paymentMode"='points',"paymentStatus"='pending' WHERE id=$1`,
        [one],
      );
      expect(await incident(one)).toBeUndefined();
      expect(await incident(two)).toMatchObject({ occurrence: null });
      await confirm(two, 1);
      await query(
        `UPDATE bookings SET "paymentMode"='points',"paymentStatus"='pending' WHERE id=$1`,
        [three],
      );
      expect(
        await query('SELECT * FROM driver_cash_exception_trips'),
      ).toHaveLength(1);
      expect(await incident(three)).toBeUndefined();
    });
    it('fourth exception blocks new work but not existing receipts or closing a ride', async () => {
      const future = await booking({ status: 'pending', arrived: false });
      const nextTrip = randomUUID();
      await query('INSERT INTO trips(id,"driverId") VALUES($1,$2)', [
        nextTrip,
        driver,
      ]);
      const ids: string[] = [];
      for (let n = 0; n < 4; n++) {
        const id = await booking({ tripId: n === 0 ? trip : await newTrip() });
        await switchCash(id);
        ids.push(id);
      }
      for (let n = 0; n < ids.length; n++) await confirm(ids[n], n + 1);
      expect(await incident(ids[3])).toMatchObject({
        occurrence: 4,
        penaltyAmount: '3000.00',
      });
      expect(
        await query('SELECT * FROM driver_cash_restrictions'),
      ).toHaveLength(1);
      await expect(
        query('INSERT INTO trips(id,"driverId") VALUES($1,$2)', [
          randomUUID(),
          driver,
        ]),
      ).rejects.toThrow('DRIVER_CASH_RESTRICTED');
      await expect(
        query("UPDATE trips SET status='ongoing' WHERE id=$1", [nextTrip]),
      ).rejects.toThrow('DRIVER_CASH_RESTRICTED');
      await expect(
        query('INSERT INTO driver_offers(id,"driverId") VALUES($1,$2)', [
          randomUUID(),
          driver,
        ]),
      ).rejects.toThrow('DRIVER_CASH_RESTRICTED');
      await expect(
        query("UPDATE bookings SET status='accepted' WHERE id=$1", [future]),
      ).rejects.toThrow('DRIVER_CASH_RESTRICTED');
      await query("UPDATE trips SET status='completed' WHERE id=$1", [trip]);
      await confirm(ids[3], 4);
      expect(
        (await query('SELECT "isActive" FROM users WHERE id=$1', [driver]))[0]
          .isActive,
      ).toBe(true);
    });
    it('regular cash fallback is not an offence; insufficient funds never bypass an administrative wallet block', async () => {
      const id = await booking();
      await query('UPDATE wallet_accounts SET balance=100 WHERE "userId"=$1', [
        driver,
      ]);
      await switchCash(id);
      await confirm(id);
      expect(await incident(id)).toBeUndefined();
      const blocked = await booking();
      await query(
        'UPDATE wallet_accounts SET balance=0,"withdrawalsBlocked"=true WHERE "userId"=$1',
        [driver],
      );
      await expect(switchCash(blocked)).rejects.toThrow(
        'CASH_COMMISSION_INSUFFICIENT',
      );
      expect(await incident(blocked)).toBeUndefined();
    });
    it('never extends the exception before arrival or to already paid bookings', async () => {
      for (const data of [
        { status: 'accepted', arrived: false },
        { status: 'completed', arrived: false },
      ]) {
        const id = await booking(data);
        await expect(switchCash(id)).rejects.toThrow();
        expect(await incident(id)).toBeUndefined();
      }
      const paid = await booking();
      await query(
        'UPDATE bookings SET "paymentStatus"=\'succeeded\' WHERE id=$1',
        [paid],
      );
      await expect(switchCash(paid)).rejects.toThrow();
      expect(await incident(paid)).toBeUndefined();
    });
    it('release gate preserves existing clients until explicitly enabled; pending receipts remain disclosed', async () => {
      const pending = await booking();
      await switchCash(pending);
      await query('UPDATE driver_cash_exception_rollout SET enabled=false');
      const id = await booking();
      await expect(switchCash(id)).rejects.toThrow('CASH_DEBT_OUTSTANDING');
      expect(
        await readCashExceptionPolicy(getDb(), driver, id, true),
      ).toBeNull();
      expect(
        (await readCashExceptionPolicy(getDb(), driver, pending, true))?.notice
          .occurrence,
      ).toBe(1);
      await confirm(pending, 1);
    });
    it('collects 3000 CDF separately, partially then on recharge, without negative funds or a second passenger debit', async () => {
      const one = await booking(),
        two = await booking({ tripId: await newTrip() });
      await switchCash(one);
      await switchCash(two);
      await confirm(one, 1);
      await query(
        'UPDATE wallet_accounts SET balance=100,"withdrawableBalance"=50 WHERE "userId"=$1',
        [driver],
      );
      await confirm(two, 2);
      expect(await incident(two)).toMatchObject({
        chargedTokens: '90.00',
        chargedWithdrawableTokens: '50.00',
      });
      expect(
        (
          await query('SELECT SUM("debtTokens") AS debt FROM cash_commissions')
        )[0].debt,
      ).toBe('0.00');
      await query(
        'UPDATE wallet_accounts SET balance=500,"withdrawableBalance"=500 WHERE "userId"=$1',
        [driver],
      );
      await query(
        `INSERT INTO wallet_ledger_entries("accountId","userId","accountType",type,amount,"withdrawableAmount","balanceAfter")
        SELECT id,$1,'points','top_up',500,500,balance FROM wallet_accounts WHERE "userId"=$1`,
        [driver],
      );
      expect(await incident(two)).toMatchObject({
        penaltyAmount: '3000.00',
        chargedTokens: '300.00',
      });
      expect(
        (
          await query(
            "SELECT SUM(-amount) AS total FROM wallet_ledger_entries WHERE type='cash_penalty'",
          )
        )[0].total,
      ).toBe('300.00');
      expect(
        (
          await query('SELECT balance FROM wallet_accounts WHERE "userId"=$1', [
            driver,
          ])
        )[0].balance,
      ).toBe('290.00');
      await confirm(two, 2);
      expect(
        await query(
          "SELECT * FROM wallet_ledger_entries WHERE type='cash_penalty'",
        ),
      ).toHaveLength(2);
    });
    it('a small recharge repays commission first and only then the penalty; repeated credits cannot overcharge', async () => {
      const one = await booking(),
        two = await booking({ tripId: await newTrip() });
      await switchCash(one);
      await switchCash(two);
      await confirm(one, 1);
      await confirm(two, 2);
      const topUp = (amount: number) =>
        getDb().transaction(async (m) => {
          await m.query(
            'UPDATE wallet_accounts SET balance=balance+$2,"withdrawableBalance"="withdrawableBalance"+$2 WHERE "userId"=$1',
            [driver, amount],
          );
          await m.query(
            `INSERT INTO wallet_ledger_entries("accountId","userId","accountType",type,amount,"withdrawableAmount","balanceAfter")
          SELECT id,$1,'points','top_up',$2,$2,balance FROM wallet_accounts WHERE "userId"=$1`,
            [driver, amount],
          );
        });
      await topUp(6);
      expect(
        (
          await query('SELECT SUM("debtTokens") AS debt FROM cash_commissions')
        )[0].debt,
      ).toBe('4.00');
      expect(await incident(two)).toMatchObject({ chargedTokens: '0.00' });
      await topUp(10);
      expect(
        (
          await query('SELECT SUM("debtTokens") AS debt FROM cash_commissions')
        )[0].debt,
      ).toBe('0.00');
      expect(await incident(two)).toMatchObject({ chargedTokens: '6.00' });
      await Promise.all([topUp(300), topUp(20)]);
      expect(await incident(two)).toMatchObject({ chargedTokens: '300.00' });
      expect(
        (
          await query('SELECT balance FROM wallet_accounts WHERE "userId"=$1', [
            driver,
          ])
        )[0].balance,
      ).toBe('26.00');
      expect(
        (
          await query(
            "SELECT SUM(-amount) AS total FROM wallet_ledger_entries WHERE type='cash_penalty'",
          )
        )[0].total,
      ).toBe('300.00');
    });
    it('rolls back the receipt, count, penalty, restriction and notification together', async () => {
      const id = await booking();
      await switchCash(id);
      await expect(
        getDb().transaction(async (m) => {
          await m.query(
            "SELECT set_config('zwanga.cash_exception_ack',$1,true)",
            [`${id}:1`],
          );
          await m.query(
            'UPDATE bookings SET "cashReceivedAt"=now(),"cashReceivedAmount"="paymentAmount","cashReceivedByDriverId"=$2 WHERE id=$1',
            [id, driver],
          );
          throw new Error('rollback fixture');
        }),
      ).rejects.toThrow('rollback fixture');
      expect(await incident(id)).toMatchObject({
        occurrence: null,
        confirmedAt: null,
      });
      expect(
        await query(
          "SELECT * FROM notifications WHERE data->>'type'='cash_exception_warning'",
        ),
      ).toHaveLength(0);
    });
    it('a rolled-back fourth trip neither restricts the driver nor charges its fee', async () => {
      for (let n = 1; n <= 3; n++) {
        const id = await booking({ tripId: n === 1 ? trip : await newTrip() });
        await switchCash(id);
        await confirm(id, n);
      }
      const last = await booking({ tripId: await newTrip() });
      await switchCash(last);
      await query(
        'UPDATE wallet_accounts SET balance=1000,"withdrawableBalance"=1000 WHERE "userId"=$1',
        [driver],
      );
      await expect(
        getDb().transaction(async (m) => {
          await m.query(
            "SELECT set_config('zwanga.cash_exception_ack',$1,true)",
            [`${last}:4`],
          );
          await m.query(
            'UPDATE bookings SET "cashReceivedAt"=now(),"cashReceivedAmount"="paymentAmount","cashReceivedByDriverId"=$2 WHERE id=$1',
            [last, driver],
          );
          throw Error('rollback fourth receipt');
        }),
      ).rejects.toThrow('rollback fourth receipt');
      expect(await incident(last)).toMatchObject({
        occurrence: null,
        confirmedAt: null,
      });
      expect(
        await query('SELECT * FROM driver_cash_exception_trips'),
      ).toHaveLength(3);
      expect(
        await query('SELECT * FROM driver_cash_restrictions'),
      ).toHaveLength(0);
      expect(
        await query(
          "SELECT * FROM wallet_ledger_entries WHERE type='cash_penalty'",
        ),
      ).toHaveLength(0);
      expect(
        (
          await query('SELECT balance FROM wallet_accounts WHERE "userId"=$1', [
            driver,
          ])
        )[0].balance,
      ).toBe('1000.00');
    });
    cashExceptionUpgradeCases(getDb, driver, { booking, switchCash, confirm, newTrip });
    it('keeps the driver history and penalty amount private in passenger options', async () => {
      const id = await booking();
      await switchCash(id);
      expect(
        (await readCashExceptionPolicy(getDb(), driver, id, true))?.notice,
      ).toMatchObject({ occurrence: 1, penaltyAmount: 0 });
      const passenger = (
        await readCashExceptionPolicy(getDb(), driver, id, false)
      )?.notice;
      expect(passenger).not.toHaveProperty('occurrence');
      expect(passenger).not.toHaveProperty('penaltyAmount');
      expect(passenger).not.toHaveProperty('alreadyCountedForTrip');
      expect(passenger?.message).toContain('prévenez le conducteur');
    });
  });
}
