import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CashCommissionAllTokenOrigins1780000055000 } from '../src/database/migrations/1780000055000-CashCommissionAllTokenOrigins';
import { applyTokenMovement } from '../src/wallet/wallet-origin';

/** Runs after the legacy-migration tests on their disposable cluster, never an app DB. */
export function cashAllTokenOriginsCases(getDb: () => DataSource, driver: string, trip: string) {
  describe('cash commission from every token origin (forward migration)', () => {
    const account = async () => (await getDb().query('SELECT * FROM wallet_accounts WHERE "userId"=$1', [driver]))[0];
    const commission = async (id: string) => (await getDb().query('SELECT * FROM cash_commissions WHERE "bookingId"=$1', [id]))[0];
    const funds = (total: number, purchased = 0) => getDb().query('UPDATE wallet_accounts SET balance=$1,"withdrawableBalance"=$2 WHERE "userId"=$3', [total, purchased, driver]);
    const status = (id: string, value: string) => getDb().query('UPDATE bookings SET status=$2 WHERE id=$1', [id, value]);
    const book = async (amount = 10000, state = 'accepted') => {
      const id = randomUUID();
      await getDb().query('INSERT INTO bookings (id,"tripId","paymentAmount",status) VALUES ($1,$2,$3,$4)', [id, trip, amount, state]);
      return id;
    };
    const credit = (amount: number, purchased = 0, type = 'loyalty_reward') => getDb().transaction(async m => {
      await m.query('UPDATE wallet_accounts SET balance=balance+$1,"withdrawableBalance"="withdrawableBalance"+$2 WHERE "userId"=$3', [amount, purchased, driver]);
      const [a] = await m.query('SELECT * FROM wallet_accounts WHERE "userId"=$1', [driver]);
      await m.query(`INSERT INTO wallet_ledger_entries ("accountId","userId",type,amount,"withdrawableAmount","balanceAfter") VALUES ($1,$2,$3,$4,$5,$6)`, [a.id, driver, type, amount, purchased, a.balance]);
    });
    const sync = (id: string, base: number, state = 'captured') => getDb().query(
      'SELECT zwanga_cash_sync($1,$2,$3,$4,100,$5,false)', [id, driver, trip, base, state]);

    beforeAll(async () => {
      // Leave real legacy charges + debt for the forward migration to preserve/reconcile.
      const historic = await book(); await status(historic, 'completed');
      await funds(10);
      const indebted = await book(50000);
      expect((await commission(indebted)).debtTokens).toBe('25.00');
      const runner = getDb().createQueryRunner();
      try {
        await runner.startTransaction();
        await new CashCommissionAllTokenOrigins1780000055000().up(runner);
        await runner.commitTransaction();
      } catch (error) { await runner.rollbackTransaction(); throw error; }
      finally { await runner.release(); }
      expect(await commission(historic)).toMatchObject({ chargedTokens: '5.00', chargedWithdrawableTokens: '5.00', commissionRate: '0.050' });
      expect(await commission(indebted)).toMatchObject({ reservedTokens: '10.00', debtTokens: '15.00' });
    });

    it('reserves and captures bonus-only funds once, without making any tokens withdrawable', async () => {
      await funds(10); const id = await book();
      expect(await account()).toMatchObject({ balance: '10.00', withdrawableBalance: '0.00', reservedCashCommissionBalance: '5.00' });
      await status(id, 'completed'); await status(id, 'completed');
      expect(await account()).toMatchObject({ balance: '5.00', withdrawableBalance: '0.00', reservedCashCommissionBalance: '0.00' });
      expect(await commission(id)).toMatchObject({ chargedTokens: '5.00', chargedWithdrawableTokens: '0.00', debtTokens: '0.00' });
      const ledger = await getDb().query(`SELECT * FROM wallet_ledger_entries WHERE type='cash_commission'`);
      expect(ledger).toHaveLength(1); expect(ledger[0].withdrawableAmount).toBe('0.00');
    });
    it('spends free rewards then purchased funds and preserves origin on partial/full refund', async () => {
      await funds(10, 8); const id = await book(); await status(id, 'completed');
      expect(await account()).toMatchObject({ balance: '5.00', withdrawableBalance: '5.00' });
      expect((await commission(id)).chargedWithdrawableTokens).toBe('3.00');
      await sync(id, 6000); // refund two purchased tokens
      expect(await account()).toMatchObject({ balance: '7.00', withdrawableBalance: '7.00' });
      await sync(id, 0, 'released'); await sync(id, 0, 'released');
      expect(await account()).toMatchObject({ balance: '10.00', withdrawableBalance: '8.00' });
      expect((await commission(id)).chargedWithdrawableTokens).toBe('0.00');
    });
    it('refunds promotional commissions as promotional tokens', async () => {
      await funds(10); const id = await book(); await status(id, 'completed');
      await sync(id, 0, 'released');
      expect(await account()).toMatchObject({ balance: '10.00', withdrawableBalance: '0.00' });
    });
    it('keeps other holds protected during capture, transfers and purchased withdrawals', async () => {
      await funds(20, 10); const first = await book(20000), second = await book(10000);
      await status(first, 'completed');
      expect(await account()).toMatchObject({ balance: '10.00', withdrawableBalance: '5.00', reservedCashCommissionBalance: '5.00' });
      const a = await account();
      expect(applyTokenMovement(a, -5, 0, true)).toBe(-5);
      await getDb().query('UPDATE wallet_accounts SET balance=$1,"withdrawableBalance"=$2 WHERE id=$3', [a.balance, a.withdrawableBalance, a.id]);
      await expect(getDb().query('UPDATE wallet_accounts SET balance=4 WHERE id=$1', [a.id])).rejects.toThrow();
      await status(second, 'completed');
      expect(await account()).toMatchObject({ balance: '0.00', withdrawableBalance: '0.00', reservedCashCommissionBalance: '0.00' });
    });
    it.each(['loyalty_reward', 'subscription_reward', 'transfer_in', 'admin_adjustment', 'booking_refund'])('uses %s credits to repay captured debt', async type => {
      await funds(0); const id = await book(50000); await status(id, 'completed');
      await credit(10, 0, type);
      expect(await account()).toMatchObject({ balance: '0.00', withdrawableBalance: '0.00' });
      expect((await commission(id)).debtTokens).toBe('15.00');
      await expect(book()).rejects.toThrow('CASH_DEBT_OUTSTANDING');
      await credit(20, 0, type);
      expect((await commission(id)).debtTokens).toBe('0.00');
      expect((await account()).balance).toBe('5.00');
      await expect(book()).resolves.toBeDefined();
    });
    it('uses new bonus credits to cover reserved debt and releases the hold on cancellation', async () => {
      await funds(0); const id = await book(50000); await credit(30);
      expect(await commission(id)).toMatchObject({ debtTokens: '0.00', reservedTokens: '25.00' });
      expect(await account()).toMatchObject({ balance: '30.00', withdrawableBalance: '0.00' });
      await status(id, 'cancelled');
      expect((await account()).reservedCashCommissionBalance).toBe('0.00');
    });
    it('lets the verified welcome bonus repay cash debt without duplicating it', async () => {
      await funds(0); const id = await book(50000); await status(id, 'completed');
      await getDb().query(`INSERT INTO kyc_documents ("userId",status) VALUES ($1,'approved')`, [driver]);
      await getDb().query('SELECT zwanga_grant_welcome_bonus($1)', [driver]);
      expect((await commission(id)).debtTokens).toBe('0.00');
      expect(await account()).toMatchObject({ balance: '25.00', withdrawableBalance: '0.00' });
    });
    it('checks all public-trip seats against all tokens without reserving them early', async () => {
      await funds(5);
      await getDb().query(`UPDATE trips SET "isPrivate"=false,"pricePerSeat"=10000,"totalSeats"=6 WHERE id=$1`, [trip]);
      expect((await account()).reservedCashCommissionBalance).toBe('0.00');
      await expect(getDb().query('UPDATE trips SET "totalSeats"=7 WHERE id=$1', [trip])).rejects.toThrow('CASH_COMMISSION_INSUFFICIENT');
    });
    it('keeps the 25-token debt cap and serializes competing acceptances', async () => {
      await funds(5);
      await expect(book(60020)).rejects.toThrow('CASH_COMMISSION_INSUFFICIENT');
      const results = await Promise.allSettled([book(60000), book(60000)]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect((await account()).reservedCashCommissionBalance).toBe('5.00');
    });
    it('allows a boarded fare increase beyond the cap and uses every subsequent credit', async () => {
      await funds(5); const id = await book();
      await expect(getDb().query('UPDATE bookings SET "paymentAmount"=100000 WHERE id=$1', [id])).rejects.toThrow('CASH_COMMISSION_INSUFFICIENT');
      await getDb().query('UPDATE bookings SET "pickedUp"=true,"paymentAmount"=100000 WHERE id=$1', [id]);
      await status(id, 'completed'); expect((await commission(id)).debtTokens).toBe('45.00');
      await credit(20); await credit(30, 30, 'top_up');
      expect(await account()).toMatchObject({ balance: '5.00', withdrawableBalance: '5.00' });
      expect((await commission(id)).debtTokens).toBe('0.00');
    });
    it('reserves dispatch bonus funds, transfers once to the booking and releases on cancellation', async () => {
      await funds(5); const rid = randomUUID(), tid = randomUUID(), bid = randomUUID();
      await getDb().query(`INSERT INTO trip_requests (id,status,"selectedDriverId","selectedPricePerSeat","numberOfSeats") VALUES ($1,'driver_selected',$2,10000,1)`, [rid, driver]);
      expect((await commission(rid)).reservedTokens).toBe('5.00');
      await getDb().query('INSERT INTO trips (id,"driverId","tripRequestId","pricePerSeat") VALUES ($1,$2,$3,10000)', [tid, driver, rid]);
      await getDb().query(`INSERT INTO bookings (id,"tripId","paymentAmount",status) VALUES ($1,$2,10000,'accepted')`, [bid, tid]);
      expect(await commission(rid)).toBeUndefined(); expect((await commission(bid)).reservedTokens).toBe('5.00');
      await status(bid, 'cancelled'); expect((await account()).reservedCashCommissionBalance).toBe('0.00');
    });
    it('still blocks reviewed wallets even when they hold bonus tokens', async () => {
      await funds(100); await getDb().query('UPDATE wallet_accounts SET "withdrawalsBlocked"=true');
      await expect(book()).rejects.toThrow('CASH_COMMISSION_INSUFFICIENT');
    });
  });
}
