import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { TokenCashFallback1780000091000 } from '../src/database/migrations/1780000091000-TokenCashFallback';

/** Runs after the mixed-cash fixture, on actual existing cash commission triggers. */
export function tokenCashCommissionCases(getDb: () => DataSource, driver: string, trip: string) {
  describe('token cash fallback with real cash commission rules', () => {
    beforeAll(async () => {
      await getDb().query('ALTER TABLE bookings ADD COLUMN "paidAt" timestamptz NULL');
      await getDb().transaction(manager => new TokenCashFallback1780000091000().up(manager.queryRunner!));
    });
    beforeEach(() => getDb().query('UPDATE financial_rollout SET enabled=true'));
    const create = async (amount = 4500) => {
      const id = randomUUID();
      await getDb().query(`INSERT INTO bookings (id,"tripId","paymentAmount","paymentMode","paymentStatus",status,"pickedUp","droppedOff","cashCommissionTokenValue")
        VALUES ($1,$2,$3,'points','pending','completed',true,true,10)`, [id, trip, amount]);
      return id;
    };
    const fallback = (id: string) => getDb().query(`UPDATE bookings SET "paymentMode"='cash',"paymentStatus"='not_required',"tokenCashFallbackAt"=now() WHERE id=$1`, [id]);
    it('collects the normal full-cash commission once without changing the passenger fare', async () => {
      const id = await create(); await fallback(id);
      const commission = async () => (await getDb().query('SELECT * FROM cash_commissions WHERE "bookingId"=$1', [id]))[0];
      expect(await commission()).toMatchObject({ commissionAmount: '225.00', tokensDue: '22.50' });
      await getDb().query('UPDATE bookings SET "paymentMode"=\'cash\' WHERE id=$1', [id]);
      expect(await commission()).toMatchObject({ commissionAmount: '225.00', tokensDue: '22.50' });
      expect((await getDb().query('SELECT balance FROM wallet_accounts WHERE "userId"=$1', [driver]))[0].balance).toBe('77.50');
      expect((await getDb().query('SELECT "paymentAmount","cashReceivedAt" FROM bookings WHERE id=$1', [id]))[0])
        .toMatchObject({ paymentAmount: '4500.00', cashReceivedAt: null });
    });
    it('keeps insufficient cash reserve/debt safeguards and rolls back the fallback marker', async () => {
      await getDb().query('UPDATE wallet_accounts SET balance=0,"withdrawableBalance"=0 WHERE "userId"=$1', [driver]);
      const id = await create(6000);
      await expect(fallback(id)).rejects.toThrow();
      expect((await getDb().query('SELECT "tokenCashFallbackAt","paymentMode" FROM bookings WHERE id=$1', [id]))[0])
        .toMatchObject({ tokenCashFallbackAt: null, paymentMode: 'points' });
    });
  });
}
