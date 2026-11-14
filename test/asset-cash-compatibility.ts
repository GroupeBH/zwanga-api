import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AssetCredits1780000124000 } from '../src/database/migrations/1780000124000-AssetCredits';
import { AssetCreditService } from '../src/asset-credit/asset-credit.service';
/** Runs after all existing cash migrations, inside the disposable finance fixture. */
export function assetCashCompatibility(
  getDb: () => DataSource,
  driver: string,
  trip: string,
) {
  describe('material credits alongside actual cash commission triggers', () => {
    beforeAll(async () => {
      const db = getDb();
      await db.query(`ALTER TABLE users ADD COLUMN "isDriver" boolean DEFAULT true;
        ALTER TABLE bookings ADD COLUMN "cashReceivedByDriverId" uuid;
        CREATE TABLE driver_earnings(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"driverId" uuid,"bookingId" uuid UNIQUE,"grossAmount" numeric(12,2),"commissionAmount" numeric(12,2),"netAmount" numeric(12,2),currency text DEFAULT 'CDF',status text DEFAULT 'available',"createdAt" timestamptz DEFAULT now());`);
      await db.transaction((m) =>
        new AssetCredits1780000124000().up(m.queryRunner!),
      );
    });
    const active = async () => {
      const db = getDb(),
        s = new AssetCreditService(db);
      await db.query(
        `INSERT INTO kyc_documents("userId",status) VALUES($1,'approved')`,
        [driver],
      );
      const { id } = await s.offer(driver, {
        mutationId: randomUUID(),
        driverId: driver,
        assetKind: 'phone',
        label: 'Test phone',
        principalMinor: 100000,
        terms:
          'Test de cohabitation des commissions et crédits dans une base temporaire.',
        validationReference: 'test',
      });
      await s.decide(id, driver, true);
      await s.activate(id, driver, {
        deliveryReference: 'test',
        assetReference: 'test',
      });
      return id;
    };
    const ride = async () => {
      const db = getDb(),
        id = randomUUID();
      await db.query(
        `INSERT INTO bookings(id,"tripId","passengerId","paymentAmount","paymentMode","cashCommissionTokenValue","cashCommissionPolicyVersion") VALUES($1,$2,$3,1000,'cash',10,2)`,
        [id, trip, randomUUID()],
      );
      await db.query("UPDATE bookings SET status='accepted' WHERE id=$1", [id]);
      await db.query(
        `UPDATE bookings SET status='completed',"pickedUp"=true,"droppedOff"=true WHERE id=$1`,
        [id],
      );
      await db.query(
        `UPDATE bookings SET "cashReceivedAt"=clock_timestamp(),"cashReceivedAmount"=1000,"cashReceivedByDriverId"=$2 WHERE id=$1`,
        [id, driver],
      );
      return id;
    };
    it('keeps 5% commission and collects only another 5% for material', async () => {
      const db = getDb();
      await db.query('UPDATE financial_rollout SET enabled=true');
      const id = await active();
      // KYC/welcome triggers may credit rewards. Capture actual balance after activation.
      const before = Number(
        (
          await db.query(
            'SELECT balance FROM wallet_accounts WHERE "userId"=$1',
            [driver],
          )
        )[0].balance,
      );
      const bid = await ride();
      const [fee] = await db.query(
        'SELECT "commissionAmount","chargedTokens" FROM cash_commissions WHERE "bookingId"=$1',
        [bid],
      );
      expect(fee).toMatchObject({
        commissionAmount: '50.00',
        chargedTokens: '5.00',
      });
      const [c] = await db.query(
        'SELECT "paidMinor","dueMinor" FROM asset_credits WHERE id=$1',
        [id],
      );
      expect(c).toEqual({ paidMinor: '5000', dueMinor: '0' });
      const after = Number(
        (
          await db.query(
            'SELECT balance FROM wallet_accounts WHERE "userId"=$1',
            [driver],
          )
        )[0].balance,
      );
      expect(before - after).toBe(10);
      await db.query(
        'UPDATE bookings SET "cashReceivedAmount"="cashReceivedAmount" WHERE id=$1',
        [bid],
      );
      expect(
        (
          await db.query('SELECT "paidMinor" FROM asset_credits WHERE id=$1', [
            id,
          ])
        )[0].paidMinor,
      ).toBe('5000');
    });
    it('never spends loyalty rewards on material even when cash commission can use them', async () => {
      const db = getDb();
      await db.query('UPDATE financial_rollout SET enabled=true');
      const id = await active();
      await db.query(
        'UPDATE wallet_accounts SET balance=100,"withdrawableBalance"=0',
      );
      await ride();
      expect(
        (
          await db.query(
            'SELECT "paidMinor","dueMinor" FROM asset_credits WHERE id=$1',
            [id],
          )
        )[0],
      ).toEqual({ paidMinor: '0', dueMinor: '5000' });
    });
  });
}
