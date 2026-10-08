import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CumulativeCashDebtLimit1780000060000 } from '../src/database/migrations/1780000060000-CumulativeCashDebtLimit';

export function cumulativeCashDebtCases(
  getDb: () => DataSource,
  driver: string,
  trip: string,
) {
  describe('cumulative 25-token cash debt ceiling', () => {
    const migrate = () =>
      getDb().transaction((m) =>
        new CumulativeCashDebtLimit1780000060000().up(m.queryRunner!),
      );
    beforeAll(migrate);
    beforeEach(async () => {
      await getDb().query('UPDATE financial_rollout SET enabled=true');
      await getDb().query(
        'UPDATE wallet_accounts SET balance=0,"withdrawableBalance"=0 WHERE "userId"=$1',
        [driver],
      );
    });
    const debt = async () =>
      Number(
        (
          await getDb().query(
            'SELECT COALESCE(SUM("debtTokens"),0) AS debt FROM cash_commissions WHERE "driverId"=$1',
            [driver],
          )
        )[0].debt,
      );
    const book = async (amount: number) => {
      const id = randomUUID();
      await getDb().query(
        `INSERT INTO bookings (id,"tripId","paymentAmount","paymentMode","cashCommissionPolicyVersion") VALUES ($1,$2,$3,'cash',2)`,
        [id, trip, amount],
      );
      return id;
    };
    const accept = (id: string) =>
      getDb().query("UPDATE bookings SET status='accepted' WHERE id=$1", [id]);
    const publish = (amount: number, explicit = true) =>
      getDb().query(
        `INSERT INTO trips
      (id,"driverId","isPrivate","pricePerSeat","totalSeats","paymentModesExplicit","acceptedPaymentModes")
      VALUES ($1,$2,false,$3,1,$4,ARRAY['cash','points']) RETURNING "acceptedPaymentModes"`,
        [randomUUID(), driver, amount, explicit],
      );

    it('allows multiple reservations up to exactly 25 total, never 25 per reservation', async () => {
      await accept(await book(20000));
      await accept(await book(29980));
      expect(await debt()).toBe(24.99);
      await accept(await book(20));
      expect(await debt()).toBe(25);
      await expect(accept(await book(20))).rejects.toThrow(
        'CASH_DEBT_OUTSTANDING',
      );
      expect(await debt()).toBe(25);
    });
    it('serializes simultaneous acceptances on the driver wallet', async () => {
      const ids = await Promise.all([book(30000), book(30000)]);
      const result = await Promise.allSettled(ids.map(accept));
      expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(await debt()).toBe(15);
    });
    it('checks existing debt plus projected publication commission without reserving twice', async () => {
      await accept(await book(40000));
      await expect(publish(10000)).resolves.toBeDefined();
      await expect(publish(10020)).rejects.toThrow(
        'CASH_COMMISSION_INSUFFICIENT',
      );
      expect(await debt()).toBe(20);
    });
    it('allows cash at 25 only when fresh commissions are fully funded', async () => {
      await accept(await book(50000));
      await expect(publish(10000)).rejects.toThrow(
        'CASH_COMMISSION_INSUFFICIENT',
      );
      // Boundary fixture only: normal inbound credits first repay existing debt.
      await getDb().query(
        'UPDATE wallet_accounts SET balance=5 WHERE "userId"=$1',
        [driver],
      );
      await expect(publish(10000)).resolves.toBeDefined();
      await accept(await book(10000));
      expect(await debt()).toBe(25);
    });
    it('preserves boarded rides above the ceiling, but blocks new paid cash', async () => {
      const id = await book(50000);
      await accept(id);
      await getDb().query(
        'UPDATE bookings SET "pickedUp"=true,"paymentAmount"=100000 WHERE id=$1',
        [id],
      );
      expect(await debt()).toBe(50);
      await expect(publish(20)).rejects.toThrow('CASH_DEBT_OUTSTANDING');
      await expect(accept(await book(20))).rejects.toThrow(
        'CASH_DEBT_OUTSTANDING',
      );
      await getDb().query(
        "UPDATE bookings SET status='completed' WHERE id=$1",
        [id],
      );
      expect(await debt()).toBe(50);
    });
    it('restores remaining allowance after partial repayment', async () => {
      const id = await book(50000);
      await accept(id);
      await getDb().query(
        "UPDATE bookings SET status='completed' WHERE id=$1",
        [id],
      );
      expect(
        (
          await getDb().query('SELECT zwanga_cash_policy_enabled() AS enabled')
        )[0].enabled,
      ).toBe(true);
      expect(
        (
          await getDb().query(
            'SELECT state,"debtTokens","chargedTokens" FROM cash_commissions WHERE "bookingId"=$1',
            [id],
          )
        )[0],
      ).toEqual({
        state: 'captured',
        debtTokens: '25.00',
        chargedTokens: '0.00',
      });
      await getDb().transaction(async (m) => {
        await m.query(
          'UPDATE wallet_accounts SET balance=balance+10 WHERE "userId"=$1',
          [driver],
        );
        const [a] = await m.query(
          'SELECT id,balance FROM wallet_accounts WHERE "userId"=$1 AND type=\'points\'',
          [driver],
        );
        await m.query(
          `INSERT INTO wallet_ledger_entries ("accountId","userId",type,amount,"withdrawableAmount","balanceAfter") VALUES ($1,$2,'loyalty_reward',10,0,$3)`,
          [a.id, driver, a.balance],
        );
      });
      expect(
        await getDb().query(
          'SELECT c.state,c."debtTokens",c."chargedTokens",a.balance,a.type FROM cash_commissions c JOIN wallet_accounts a ON a."userId"=c."driverId" WHERE c."bookingId"=$1',
          [id],
        ),
      ).toEqual([
        {
          state: 'captured',
          debtTokens: '15.00',
          chargedTokens: '10.00',
          balance: '0.00',
          type: 'points',
        },
      ]);
      await accept(await book(20000));
      expect(await debt()).toBe(25);
      await expect(accept(await book(20))).rejects.toThrow(
        'CASH_DEBT_OUTSTANDING',
      );
    });
    it('releases debt on cancellation and permits reuse of the recovered allowance', async () => {
      const id = await book(40000);
      await accept(id);
      await getDb().query(
        "UPDATE bookings SET status='cancelled' WHERE id=$1",
        [id],
      );
      expect(await debt()).toBe(0);
      await accept(await book(50000));
      expect(await debt()).toBe(25);
    });
    it('enforces publication eligibility in prepared mode without enabling collection', async () => {
      await getDb().query('UPDATE financial_rollout SET enabled=false');
      await expect(publish(50020)).rejects.toThrow(
        'CASH_COMMISSION_INSUFFICIENT',
      );
      expect((await publish(50020, false))[0].acceptedPaymentModes).toEqual([
        'points',
      ]);
      expect(
        (await getDb().query('SELECT enabled FROM financial_rollout'))[0]
          .enabled,
      ).toBe(false);
    });
    it('is repeatable without rewriting balances, debt or notifications', async () => {
      await accept(await book(20000));
      const before = await getDb().query('SELECT * FROM cash_commissions');
      const notices = await getDb().query('SELECT * FROM notifications');
      const accounts = await getDb().query('SELECT * FROM wallet_accounts');
      await migrate();
      await migrate();
      expect(await getDb().query('SELECT * FROM cash_commissions')).toEqual(
        before,
      );
      expect(await getDb().query('SELECT * FROM notifications')).toEqual(
        notices,
      );
      expect(await getDb().query('SELECT * FROM wallet_accounts')).toEqual(
        accounts,
      );
    });
  });
}
