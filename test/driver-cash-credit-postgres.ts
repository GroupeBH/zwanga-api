import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { DriverCashSixTripCredit1780000118000 } from '../src/database/migrations/1780000118000-DriverCashSixTripCredit';

/** Real triggers and ledger, disposable cluster only. */
export function driverCashCreditCases(
  getDb: () => DataSource,
  driver: string,
  trip: string,
) {
  describe('six first cash trips on credit, once per driver', () => {
    const sql = (query: string, args?: unknown[]) =>
      getDb().query<Record<string, string>[]>(query, args);
    const migrate = (direction: 'up' | 'down') =>
      getDb().transaction((m) =>
        new DriverCashSixTripCredit1780000118000()[direction](m.queryRunner!),
      );
    beforeAll(() => migrate('up'));
    beforeEach(async () => {
      await sql('UPDATE financial_rollout SET enabled=true');
      await sql(
        'UPDATE wallet_accounts SET balance=0,"withdrawableBalance"=0 WHERE "userId"=$1',
        [driver],
      );
    });
    const newTrip = async () => {
      const id = randomUUID();
      await sql('INSERT INTO trips (id,"driverId") VALUES ($1,$2)', [
        id,
        driver,
      ]);
      return id;
    };
    const book = async (tid: string, mode = 'cash') => {
      const id = randomUUID();
      await sql(
        `INSERT INTO bookings (id,"tripId","passengerId","paymentAmount","paymentMode",status,"cashCommissionTokenValue","cashCommissionPolicyVersion")
        VALUES ($1,$2,$3,10000,$4,'pending',10,2)`,
        [id, tid, randomUUID(), mode],
      );
      return id;
    };
    const accept = (id: string) =>
      sql("UPDATE bookings SET status='accepted' WHERE id=$1", [id]);
    const finish = (id: string) =>
      sql(
        `UPDATE bookings SET status='completed',"pickedUp"=true,"droppedOff"=true WHERE id=$1`,
        [id],
      );
    const receipt = (id: string) =>
      sql(
        'UPDATE bookings SET "cashReceivedAt"=COALESCE("cashReceivedAt",now()),"cashReceivedAmount"="paymentAmount" WHERE id=$1',
        [id],
      );
    const commission = async (id: string) =>
      (
        await sql('SELECT * FROM cash_commissions WHERE "bookingId"=$1', [id])
      )[0];
    const count = async (kind = 'used') =>
      Number(
        (await sql(`SELECT zwanga_cash_credit_${kind}($1) AS n`, [driver]))[0]
          .n,
      );
    const funds = () =>
      sql(
        'SELECT balance,"reservedCashCommissionBalance" FROM wallet_accounts WHERE "userId"=$1',
        [driver],
      );
    const topup = async (amount: number) => {
      await sql(
        'UPDATE wallet_accounts SET balance=balance+$2 WHERE "userId"=$1',
        [driver, amount],
      );
      await sql(
        `INSERT INTO wallet_ledger_entries ("accountId","userId",type,amount,"withdrawableAmount","balanceAfter")
        SELECT id,$1,'loyalty_reward',$2,0,balance FROM wallet_accounts WHERE "userId"=$1`,
        [driver, amount],
      );
    };
    const six = async () => {
      for (let i = 0; i < 6; i++) {
        const id = await book(await newTrip());
        await accept(id);
        await finish(id);
        await receipt(id);
      }
    };

    it('accrues 5% on six trips, blocks seventh, repays through tokens without resetting entitlement', async () => {
      await six();
      expect(await count()).toBe(6);
      expect(await count('paid')).toBe(6);
      expect(
        (
          await sql(
            'SELECT SUM("debtTokens") AS debt,SUM("commissionAmount") AS fee FROM cash_commissions',
          )
        )[0],
      ).toEqual({ debt: '300.00', fee: '3000.00' });
      const seventh = await book(await newTrip());
      await expect(accept(seventh)).rejects.toThrow('CASH_DEBT_OUTSTANDING');
      await topup(100);
      await expect(accept(seventh)).rejects.toThrow('CASH_DEBT_OUTSTANDING');
      await topup(200);
      await expect(accept(seventh)).rejects.toThrow(
        'CASH_COMMISSION_INSUFFICIENT',
      );
      await topup(49);
      await expect(accept(seventh)).rejects.toThrow(
        'CASH_COMMISSION_INSUFFICIENT',
      );
      await topup(1);
      await accept(seventh);
      await finish(seventh);
      await receipt(seventh);
      expect(await commission(seventh)).toMatchObject({
        commissionRate: '0.050',
        chargedTokens: '50.00',
        debtTokens: '0.00',
        cashCreditTripId: null,
      });
      expect(await funds()).toEqual([
        { balance: '0.00', reservedCashCommissionBalance: '0.00' },
      ]);
      await expect(accept(await book(await newTrip()))).rejects.toThrow(
        'CASH_COMMISSION_INSUFFICIENT',
      );
    });
    it('counts a shared trip once but charges every passenger and retries only once', async () => {
      for (let i = 0; i < 5; i++) {
        const id = await book(trip);
        await accept(id);
        await finish(id);
        await receipt(id);
        const previous = await commission(id);
        await finish(id);
        await receipt(id);
        expect(await commission(id)).toEqual(previous);
      }
      expect(await count('paid')).toBe(1);
      expect(await sql('SELECT * FROM driver_cash_credit_trips')).toHaveLength(
        1,
      );
      expect(
        (await sql('SELECT SUM("debtTokens") AS debt FROM cash_commissions'))[0]
          .debt,
      ).toBe('250.00');
    });
    it('serializes seven concurrent admissions and reserves only six places', async () => {
      const ids = await Promise.all(
        Array.from({ length: 7 }, async () => book(await newTrip())),
      );
      const results = await Promise.allSettled(ids.map(accept));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(await count()).toBe(6);
      expect(await count('paid')).toBe(0);
    });
    it('releases cancelled/no-show slots, never a previously confirmed cash trip', async () => {
      const ids = [] as string[];
      for (let i = 0; i < 6; i++) {
        const id = await book(await newTrip());
        await accept(id);
        ids.push(id);
      }
      await sql("UPDATE bookings SET status='cancelled' WHERE id=$1", [ids[0]]);
      await sql("UPDATE bookings SET status='no_show' WHERE id=$1", [ids[1]]);
      await finish(ids[2]);
      await receipt(ids[2]);
      expect(await count()).toBe(4);
      await sql("UPDATE bookings SET status='cancelled' WHERE id=$1", [ids[2]]);
      expect(await count()).toBe(4);
      expect(await count('paid')).toBe(1);
    });
    it('ignores non-cash and empty trips; cash fallback owes full commission and occupies a slot', async () => {
      const ids = [] as string[];
      for (let i = 0; i < 8; i++) {
        const id = await book(await newTrip(), 'points');
        await accept(id);
        await finish(id);
        ids.push(id);
      }
      await newTrip();
      expect(await count()).toBe(0);
      await sql(
        `UPDATE bookings SET "paymentMode"='cash',"tokenCashFallbackAt"=now() WHERE id=$1`,
        [ids[0]],
      );
      await receipt(ids[0]);
      expect(await commission(ids[0])).toMatchObject({
        commissionRate: '0.050',
        debtTokens: '50.00',
      });
      expect(await count('paid')).toBe(1);
    });
    it('includes historical cash receipts and preserves previously paid commissions', async () => {
      // An unused migration can be reverted; seed genuine historical data under the previous policy.
      await migrate('down');
      await topup(400);
      const ids = [] as string[];
      for (let i = 0; i < 6; i++) {
        const id = await book(await newTrip());
        await accept(id);
        await finish(id);
        await receipt(id);
        ids.push(id);
      }
      const previous = await commission(ids[0]);
      await migrate('up');
      expect(await count('paid')).toBe(6);
      await finish(ids[0]);
      expect(await commission(ids[0])).toMatchObject(previous);
      await sql('UPDATE wallet_accounts SET balance=0 WHERE "userId"=$1', [
        driver,
      ]);
      await expect(accept(await book(trip))).rejects.toThrow(
        'CASH_COMMISSION_INSUFFICIENT',
      );
    });
    it('retains reservations through staged completion until an actual receipt', async () => {
      const id = await book(trip);
      await accept(id);
      await sql("UPDATE bookings SET status='completed' WHERE id=$1", [id]);
      for (let i = 0; i < 5; i++) await accept(await book(await newTrip()));
      expect(await count()).toBe(6);
      expect(await count('paid')).toBe(0);
      await expect(accept(await book(await newTrip()))).rejects.toThrow(
        'CASH_DEBT_OUTSTANDING',
      );
      await finish(id);
      expect(await count('paid')).toBe(0);
      await receipt(id);
      expect(await count('paid')).toBe(1);
    });
    it('never unblocks frozen wallets or grants self-bookings an advance', async () => {
      await sql(
        'UPDATE wallet_accounts SET "withdrawalsBlocked"=true WHERE "userId"=$1',
        [driver],
      );
      await expect(accept(await book(trip))).rejects.toThrow(
        'CASH_COMMISSION_INSUFFICIENT',
      );
      await sql(
        'UPDATE wallet_accounts SET "withdrawalsBlocked"=false WHERE "userId"=$1',
        [driver],
      );
      const id = await book(trip);
      await sql('UPDATE bookings SET "passengerId"=$2 WHERE id=$1', [
        id,
        driver,
      ]);
      await expect(accept(id)).rejects.toThrow('CASH_COMMISSION_INSUFFICIENT');
      expect(await count()).toBe(0);
    });
    it('does not reuse a cancelled grant after six other slots are consumed', async () => {
      const id = await book(trip);
      await accept(id);
      await sql("UPDATE bookings SET status='cancelled' WHERE id=$1", [id]);
      await six();
      await expect(accept(id)).rejects.toThrow('CASH_DEBT_OUTSTANDING');
    });
    it('does not reserve credit at publication and enforces funding after six', async () => {
      await sql(
        `INSERT INTO trip_requests(id,status,"paymentMode","selectedDriverId","selectedPricePerSeat","cashCommissionPolicyVersion")
          VALUES($1,'driver_selected','cash',$2,0,2)`,
        [randomUUID(), driver],
      );
      const publish = () =>
        sql(
          `INSERT INTO trips(id,"driverId","isPrivate","pricePerSeat","totalSeats","paymentModesExplicit","acceptedPaymentModes")
        VALUES($1,$2,false,10000,1,true,ARRAY['cash'])`,
          [randomUUID(), driver],
        );
      for (let i = 0; i < 8; i++) await publish();
      expect(await count()).toBe(0);
      await six();
      await expect(publish()).rejects.toThrow('CASH_DEBT_OUTSTANDING');
      await topup(349);
      await expect(publish()).rejects.toThrow('CASH_COMMISSION_INSUFFICIENT');
      await topup(1);
      await publish();
    });
    it('transfers one request reservation to its booking at 10 FC per token, without duplicate debt', async () => {
      const rid = randomUUID();
      await sql(
        `INSERT INTO trip_requests(id,status,"paymentMode","selectedDriverId","selectedPricePerSeat","cashCommissionPolicyVersion")
        VALUES($1,'driver_selected','cash',$2,10000,2)`,
        [rid, driver],
      );
      expect(await count()).toBe(1);
      expect(await commission(rid)).toMatchObject({
        moneyPerToken: '10.0000',
        debtTokens: '50.00',
      });
      const tid = randomUUID();
      await sql(
        'INSERT INTO trips(id,"driverId","tripRequestId") VALUES($1,$2,$3)',
        [tid, driver, rid],
      );
      const id = await book(tid);
      await accept(id);
      await sql('UPDATE trip_requests SET "tripId"=$2 WHERE id=$1', [rid, tid]);
      await finish(id);
      await receipt(id);
      expect(await count()).toBe(1);
      expect(await count('paid')).toBe(1);
      expect(await commission(id)).toMatchObject({
        commissionRate: '0.050',
        debtTokens: '50.00',
        requestId: rid,
        tripId: tid,
      });
      expect(
        (await sql('SELECT SUM("debtTokens") AS debt FROM cash_commissions'))[0]
          .debt,
      ).toBe('50.00');
    });
    it('releases declined requests and rolls back failed acceptance atomically', async () => {
      const rid = randomUUID();
      await sql(
        `INSERT INTO trip_requests(id,status,"paymentMode","selectedDriverId","selectedPricePerSeat","cashCommissionPolicyVersion")
        VALUES($1,'driver_selected','cash',$2,10000,2)`,
        [rid, driver],
      );
      await sql(
        'UPDATE trip_requests SET status=\'pending\',"selectedDriverId"=NULL WHERE id=$1',
        [rid],
      );
      expect(await count()).toBe(0);
      const id = await book(trip);
      await expect(
        getDb().transaction(async (m) => {
          await m.query("UPDATE bookings SET status='accepted' WHERE id=$1", [
            id,
          ]);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await count()).toBe(0);
      expect(await commission(id)).toBeUndefined();
    });
    it('uses available tokens first, and collects only the remaining debt on top-up', async () => {
      await topup(20);
      const id = await book(trip);
      await accept(id);
      await finish(id);
      await receipt(id);
      expect(await commission(id)).toMatchObject({
        chargedTokens: '20.00',
        debtTokens: '30.00',
      });
      await topup(40);
      expect(await commission(id)).toMatchObject({
        chargedTokens: '50.00',
        debtTokens: '0.00',
      });
      expect((await funds())[0].balance).toBe('10.00');
      expect(await count('paid')).toBe(1);
    });
    it('permits unused rollback but refuses to erase used financial evidence', async () => {
      await migrate('down');
      await migrate('up');
      await accept(await book(trip));
      await expect(migrate('down')).rejects.toThrow('Cannot erase');
    });
    it('enriches each driver receipt once with the fee, due and lifetime progress', async () => {
      for (let i = 1; i <= 6; i++) {
        const id = await book(await newTrip());
        await accept(id);
        await finish(id);
        await receipt(id);
        const emit = (role: string) =>
          sql(
            `INSERT INTO notifications ("eventKey","userId",body,data) VALUES($1,$2,'Cash reçu.', $3::jsonb)
          ON CONFLICT ("eventKey") DO NOTHING`,
            [
              `${id}:${role}`,
              driver,
              JSON.stringify({
                type: 'cash_payment_confirmed',
                role,
                bookingId: id,
              }),
            ],
          );
        await emit('driver');
        await emit('driver');
        await emit('passenger');
        const [notice] = await sql(
          'SELECT body,data FROM notifications WHERE "eventKey"=$1',
          [`${id}:driver`],
        );
        expect(notice.body).toContain('Commission Zwanga 5 % : 500.00 FC');
        expect(notice.body).toContain(
          `Total restant dû : ${(i * 500).toFixed(2)} FC`,
        );
        expect(notice.body).toContain(`Trajets cash payés : ${i}/6`);
        expect(notice.body).toContain(
          i === 6 ? 'Avance terminée' : 'avance est unique',
        );
        expect(notice.data).toMatchObject({
          cashCommissionAmount: 500,
          cashCommissionDebtAmount: i * 500,
          cashCreditPaidTrips: i,
        });
        expect(
          (
            await sql('SELECT body FROM notifications WHERE "eventKey"=$1', [
              `${id}:passenger`,
            ])
          )[0].body,
        ).toBe('Cash reçu.');
      }
      expect(
        (
          await sql(
            `SELECT COUNT(*) AS n FROM notifications WHERE data->>'type'='cash_payment_confirmed' AND data->>'role'='driver'`,
          )
        )[0].n,
      ).toBe('6');
    });
  });
}
