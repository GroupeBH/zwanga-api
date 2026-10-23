import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { MixedTokensCash1780000089000 } from '../src/database/migrations/1780000089000-MixedTokensCash';

/** Extends the real legacy cash-trigger fixture; no replacement of its functions. */
export function mixedCashCommissionCases(
  getDb: () => DataSource,
  driver: string,
  trip: string,
) {
  describe('mixed payment using unchanged cash commission rules', () => {
    beforeAll(async () => {
      await getDb().query(`ALTER TABLE bookings
        ADD COLUMN "paymentStatus" text DEFAULT 'not_required', ADD COLUMN "droppedOff" boolean DEFAULT false,
        ADD COLUMN "grossPaymentAmount" numeric, ADD COLUMN "zwangaSubsidyAmount" numeric DEFAULT 0,
        ADD COLUMN "passengerId" uuid, ADD COLUMN "cashReceivedAmount" numeric;
        CREATE TABLE payment_transactions (id uuid PRIMARY KEY, purpose text, "relatedEntityType" text, "relatedEntityId" text);
        ALTER TABLE bookings ADD CONSTRAINT test_cash_receipt_amount CHECK
          ("cashReceivedAmount" IS NULL OR "cashReceivedAmount" = "paymentAmount");`);
      await getDb().transaction((m) =>
        new MixedTokensCash1780000089000().up(m.queryRunner!),
      );
    });
    beforeEach(() =>
      getDb().query('UPDATE financial_rollout SET enabled=true'),
    );
    it('reconciles cash commission from 225 to 196 FC exactly once; 29 FC applies separately to tokens', async () => {
      const id = randomUUID();
      await getDb().query(
        `INSERT INTO bookings (id,"tripId","paymentAmount","grossPaymentAmount","cashCommissionTokenValue") VALUES ($1,$2,4500,4500,10)`,
        [id, trip],
      );
      await getDb().query(
        `UPDATE bookings SET status='completed',"pickedUp"=true,"droppedOff"=true WHERE id=$1`,
        [id],
      );
      const commission = async () =>
        (
          await getDb().query<
            { commissionAmount: string; tokensDue: string }[]
          >('SELECT * FROM cash_commissions WHERE "bookingId"=$1', [id])
        )[0];
      expect((await commission()).commissionAmount).toBe('225.00');
      await getDb().query(
        `UPDATE bookings SET "paymentAmount"=3920,"mixedTokenAmount"=580,"mixedTokenQuantity"=58,"mixedPaymentAt"=now() WHERE id=$1`,
        [id],
      );
      expect(await commission()).toMatchObject({
        commissionAmount: '196.00',
        tokensDue: '19.60',
      });
      await getDb().query(
        `UPDATE bookings SET "paymentAmount"=3920 WHERE id=$1`,
        [id],
      );
      expect((await commission()).commissionAmount).toBe('196.00');
      const refunds = await getDb().query<{ amount: string }[]>(
        `SELECT * FROM wallet_ledger_entries WHERE "relatedEntityId"=$1 AND type='cash_commission_refund'`,
        [id],
      );
      expect(refunds).toHaveLength(1);
      expect(Number(refunds[0].amount)).toBe(2.9);
      await expect(
        getDb().query(
          'UPDATE bookings SET "cashReceivedAmount"=4500 WHERE id=$1',
          [id],
        ),
      ).rejects.toThrow();
      await getDb().query(
        'UPDATE bookings SET "cashReceivedAmount"=3920,"cashReceivedAt"=now() WHERE id=$1',
        [id],
      );
      expect((await commission()).commissionAmount).toBe('196.00');
      expect(Number((await commission()).commissionAmount) + 29).toBe(225);
      expect(
        (
          await getDb().query<{ balance: string }[]>(
            'SELECT balance FROM wallet_accounts WHERE "userId"=$1',
            [driver],
          )
        )[0].balance,
      ).toBe('80.40');
    });
    it('can roll back an unused migration, and refuses to erase a real split', async () => {
      // This test starts from empty bookings through the parent fixture.
      await getDb().transaction((m) =>
        new MixedTokensCash1780000089000().down(m.queryRunner!),
      );
      await getDb().transaction((m) =>
        new MixedTokensCash1780000089000().up(m.queryRunner!),
      );
      const id = randomUUID();
      await getDb().query(
        `INSERT INTO bookings (id,"tripId","paymentAmount","cashCommissionTokenValue",status,"droppedOff") VALUES ($1,$2,4500,10,'completed',true)`,
        [id, trip],
      );
      await getDb().query(
        `UPDATE bookings SET "paymentAmount"=3920,"mixedTokenAmount"=580,"mixedTokenQuantity"=58,"mixedPaymentAt"=now() WHERE id=$1`,
        [id],
      );
      await expect(
        getDb().transaction((m) =>
          new MixedTokensCash1780000089000().down(m.queryRunner!),
        ),
      ).rejects.toThrow('Cannot erase');
    });
  });
}
