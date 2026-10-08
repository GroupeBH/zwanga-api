import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { cancelEmptyRequestTrip } from '../src/trips/cancel-empty-request-trip';
import { Trip } from '../src/trips/entities/trip.entity';
import { FixPublicationRequestUuid1780000057000 } from '../src/database/migrations/1780000057000-FixPublicationRequestUuid';
import { FixBookingRequestUuid1780000058000 } from '../src/database/migrations/1780000058000-FixBookingRequestUuid';

export function publicationRequestUuidCases(getDb: () => DataSource, driver: string) {
  describe('private request publication with the real varchar request link', () => {
    const migrate = () => getDb().transaction(manager =>
      new FixPublicationRequestUuid1780000057000().up(manager.queryRunner!));
    beforeAll(async () => {
      // The legacy test schema used uuid here, hiding the production mismatch.
      await getDb().query('ALTER TABLE trips ALTER COLUMN "tripRequestId" TYPE varchar USING "tripRequestId"::text');
      await getDb().query(`ALTER TABLE trips ADD COLUMN status text DEFAULT 'upcoming', ADD COLUMN "updatedAt" timestamp DEFAULT now()`);
      // This fixture changed a row type after earlier tests prepared PL/pgSQL plans.
      // Recompile the unchanged legacy body before reproducing the real comparison.
      for (const fn of ['zwanga_publication_cash_guard()', 'zwanga_booking_cash_guard()']) {
        const [row] = await getDb().query('SELECT pg_get_functiondef($1::regprocedure) AS definition', [fn]);
        await getDb().query(row.definition);
      }
    });
    beforeEach(async () => { await getDb().query('UPDATE financial_rollout SET enabled=true'); });
    const request = async (mode = 'cash') => {
      const id = randomUUID();
      await getDb().query('INSERT INTO trip_requests (id,"paymentMode") VALUES ($1,$2)', [id, mode]);
      return id;
    };
    const publish = (id: string, price = 8500) => getDb().query(
      `INSERT INTO trips (id,"driverId","tripRequestId","isPrivate","pricePerSeat") VALUES ($1,$2,$3,true,$4) RETURNING id`,
      [randomUUID(), driver, id, price]);

    it('reproduces 42883 before repair then creates the private trip without changing money', async () => {
      const id = await request();
      await expect(publish(id)).rejects.toMatchObject({ driverError: { code: '42883' } });
      const balance = await getDb().query('SELECT * FROM wallet_accounts');
      await migrate();
      await expect(publish(id)).resolves.toHaveLength(1);
      expect(await getDb().query('SELECT * FROM wallet_accounts')).toEqual(balance);
      expect(await getDb().query('SELECT * FROM cash_commissions')).toHaveLength(0);
    });
    it('is idempotent and preserves the deployed policy except for the cast', async () => {
      const definition = () => getDb().query("SELECT pg_get_functiondef('zwanga_publication_cash_guard()'::regprocedure) AS definition");
      const before = await definition();
      await migrate();
      expect(await definition()).toEqual(before);
      expect(before[0].definition).toContain('NEW."tripRequestId"::uuid');
      expect(before[0].definition).toContain('zwanga_cash_policy_enabled()');
    });
    it('still rejects cash beyond the credit ceiling and accepts electronic requests', async () => {
      await expect(publish(await request(), 1_000_000)).rejects.toThrow('CASH_COMMISSION_INSUFFICIENT');
      await expect(publish(await request('electronic'), 1_000_000)).resolves.toHaveLength(1);
    });
    it('leaves cash controls inactive when the rollout is prepared, not enabled', async () => {
      await getDb().query('UPDATE financial_rollout SET enabled=false');
      await expect(publish(await request(), 1_000_000)).resolves.toHaveLength(1);
    });
    it('does not count an existing dispatch commission hold twice', async () => {
      const id = await request();
      await getDb().query(`UPDATE trip_requests SET status='driver_selected',"selectedDriverId"=$2,
        "selectedPricePerSeat"=8500 WHERE id=$1`, [id, driver]);
      const hold = await getDb().query('SELECT * FROM cash_commissions');
      expect(hold).toHaveLength(1);
      await expect(publish(id)).resolves.toHaveLength(1);
      expect(await getDb().query('SELECT * FROM cash_commissions')).toEqual(hold);
    });
    it('reproduces the second UUID failure at booking creation, then accepts and completes cash', async () => {
      const id = await request();
      const [trip] = await publish(id);
      const booking = randomUUID();
      const create = () => getDb().query(`INSERT INTO bookings (id,"tripId","paymentAmount") VALUES ($1,$2,8500)`, [booking, trip.id]);
      await expect(create()).rejects.toMatchObject({ driverError: { code: '42883' } });
      await getDb().transaction(m => new FixBookingRequestUuid1780000058000().up(m.queryRunner!));
      await create();
      await getDb().query(`UPDATE bookings SET status='accepted' WHERE id=$1`, [booking]);
      expect((await getDb().query('SELECT state,"tokensDue" FROM cash_commissions'))[0]).toEqual({ state: 'reserved', tokensDue: '4.25' });
      await getDb().query(`UPDATE bookings SET status='completed' WHERE id=$1`, [booking]);
      expect((await getDb().query('SELECT state FROM cash_commissions'))[0].state).toBe('captured');
    });
    it('transfers a dispatch request hold onto the real booking without double debit', async () => {
      const id = await request();
      await getDb().query(`UPDATE trip_requests SET status='driver_selected',"selectedDriverId"=$2,"selectedPricePerSeat"=8500 WHERE id=$1`, [id, driver]);
      const [trip] = await publish(id);
      const booking = randomUUID();
      const before = await getDb().query('SELECT balance,"reservedCashCommissionBalance" FROM wallet_accounts');
      await getDb().query(`INSERT INTO bookings (id,"tripId","paymentAmount") VALUES ($1,$2,8500)`, [booking, trip.id]);
      await getDb().query(`UPDATE bookings SET status='accepted' WHERE id=$1`, [booking]);
      const holds = await getDb().query('SELECT "bookingId","requestId",state FROM cash_commissions');
      expect(holds).toEqual([{ bookingId: booking, requestId: id, state: 'reserved' }]);
      expect(await getDb().query('SELECT balance,"reservedCashCommissionBalance" FROM wallet_accounts')).toEqual(before);
    });
    const cancel = (tripId: string, requestId: string, owner = driver) => cancelEmptyRequestTrip(
      { manager: getDb().manager } as Repository<Trip>, tripId, owner, requestId);
    it('cancels only the empty provisional trip and leaves the request available for retry', async () => {
      const id = await request('electronic');
      const [trip] = await publish(id);
      expect(await cancel(trip.id, id)).toBe(true);
      expect(await cancel(trip.id, id)).toBe(false);
      expect((await getDb().query('SELECT status FROM trip_requests WHERE id=$1', [id]))[0].status).toBe('pending');
      expect((await getDb().query('SELECT status FROM trips WHERE id=$1', [trip.id]))[0].status).toBe('cancelled');
    });
    it('preserves another driver, request, public trip and ongoing trip', async () => {
      const id = await request('electronic');
      const [trip] = await publish(id);
      expect(await cancel(trip.id, id, randomUUID())).toBe(false);
      expect(await cancel(trip.id, randomUUID())).toBe(false);
      await getDb().query(`UPDATE trips SET "isPrivate"=false WHERE id=$1`, [trip.id]);
      expect(await cancel(trip.id, id)).toBe(false);
      await getDb().query(`UPDATE trips SET "isPrivate"=true,status='ongoing' WHERE id=$1`, [trip.id]);
      expect(await cancel(trip.id, id)).toBe(false);
    });
    it('never cancels a booking that committed despite a failed HTTP response', async () => {
      const id = await request('electronic');
      const [trip] = await publish(id);
      await getDb().query(`INSERT INTO bookings (id,"tripId","paymentMode") VALUES ($1,$2,'electronic')`, [randomUUID(), trip.id]);
      expect(await cancel(trip.id, id)).toBe(false);
    });
    it('waits for an in-flight booking before deciding whether the trip is empty', async () => {
      const id = await request('electronic');
      const [trip] = await publish(id);
      const runner = getDb().createQueryRunner();
      await runner.startTransaction();
      try {
        await runner.query(`INSERT INTO bookings (id,"tripId","paymentMode") VALUES ($1,$2,'electronic')`, [randomUUID(), trip.id]);
        const pendingCancel = cancel(trip.id, id);
        await runner.commitTransaction();
        expect(await pendingCancel).toBe(false);
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }
    });
  });
}
