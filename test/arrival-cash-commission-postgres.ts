import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ArrivalCashFallback1780000143000 } from '../src/database/migrations/1780000143000-ArrivalCashFallback';

/** After tokenCashCommissionCases: existing commission triggers, no application DB. */
export function arrivalCashCommissionCases(
  getDb: () => DataSource,
  driver: string,
  trip: string,
) {
  describe('arrival cash fallback without published cash', () => {
    const read = (sql: string, params: unknown[]) =>
      getDb().query<Record<string, unknown>[]>(sql, params);
    beforeAll(() =>
      getDb().transaction((manager) =>
        new ArrivalCashFallback1780000143000().up(manager.queryRunner!),
      ),
    );
    beforeEach(async () => {
      await getDb().query('UPDATE financial_rollout SET enabled=true');
      await getDb().query(
        `UPDATE trips SET "acceptedPaymentModes"=ARRAY['points','electronic'] WHERE id=$1`,
        [trip],
      );
    });
    const create = async (
      mode = 'points',
      status = 'completed',
      arrived = true,
      paid = false,
    ) => {
      const id = randomUUID();
      await getDb().query(
        `INSERT INTO bookings (id,"tripId","paymentAmount","paymentMode","paymentStatus",status,"pickedUp","droppedOff","cashCommissionTokenValue")
        VALUES ($1,$2,4500,$3,$4,$5,true,$6,10)`,
        [id, trip, mode, paid ? 'succeeded' : 'pending', status, arrived],
      );
      return id;
    };
    const fallback = (id: string) =>
      getDb().query(
        `UPDATE bookings SET "paymentMode"='cash',"paymentStatus"='not_required' WHERE id=$1`,
        [id],
      );
    it.each(['points', 'electronic'])(
      'settles %s in cash with the normal commission exactly once',
      async (mode) => {
        const id = await create(mode);
        await fallback(id);
        await fallback(id);
        expect(
          (
            await read('SELECT * FROM cash_commissions WHERE "bookingId"=$1', [
              id,
            ])
          )[0],
        ).toMatchObject({ commissionAmount: '225.00', tokensDue: '22.50' });
        expect(
          (
            await read(
              'SELECT balance FROM wallet_accounts WHERE "userId"=$1',
              [driver],
            )
          )[0].balance,
        ).toBe('77.50');
        expect(
          (
            await read(
              'SELECT "paymentAmount","cashReceivedAt" FROM bookings WHERE id=$1',
              [id],
            )
          )[0],
        ).toMatchObject({ paymentAmount: '4500.00', cashReceivedAt: null });
        expect(
          (
            await read('SELECT "acceptedPaymentModes" FROM trips WHERE id=$1', [
              trip,
            ])
          )[0].acceptedPaymentModes,
        ).toEqual(['points', 'electronic']);
      },
    );
    it('also allows the fenced token-top-up fallback without the cash publication option', async () => {
      const id = await create();
      await getDb().query(
        `UPDATE bookings SET "paymentMode"='cash',"paymentStatus"='not_required',"tokenCashFallbackAt"=now() WHERE id=$1`,
        [id],
      );
      expect(
        (
          await read('SELECT "tokenCashFallbackAt" FROM bookings WHERE id=$1', [
            id,
          ])
        )[0].tokenCashFallbackAt,
      ).not.toBeNull();
    });
    it('does not bypass the published modes for a new reservation or before confirmed arrival', async () => {
      await expect(create('cash', 'pending', false)).rejects.toThrow(
        'TRIP_PAYMENT_MODE_UNAVAILABLE',
      );
      for (const [status, arrived] of [
        ['pending', false],
        ['accepted', true],
        ['completed', false],
      ] as const) {
        const id = await create('points', status, arrived);
        await expect(fallback(id)).rejects.toThrow(
          'TRIP_PAYMENT_MODE_UNAVAILABLE',
        );
      }
    });
    it('cannot downgrade a paid booking or introduce a mixed settlement through the full-cash exception', async () => {
      const paid = await create('points', 'completed', true, true);
      await expect(fallback(paid)).rejects.toThrow(
        'TRIP_PAYMENT_MODE_UNAVAILABLE',
      );
      const id = await create();
      await expect(
        getDb().query(
          `UPDATE bookings SET "paymentMode"='cash',"paymentStatus"='not_required',"mixedPaymentAt"=now() WHERE id=$1`,
          [id],
        ),
      ).rejects.toThrow('TRIP_PAYMENT_MODE_UNAVAILABLE');
    });
    it('retains commission capacity safeguards without partially changing the booking', async () => {
      await getDb().query(
        'UPDATE wallet_accounts SET balance=0,"withdrawableBalance"=0 WHERE "userId"=$1',
        [driver],
      );
      const id = await create();
      // This stage of the historical migration chain still permits 25 tokens
      // of debt. A 6,000 CDF fare needs 30 tokens and genuinely exceeds it.
      await getDb().query(
        'UPDATE bookings SET "paymentAmount"=6000 WHERE id=$1',
        [id],
      );
      await expect(fallback(id)).rejects.toThrow();
      expect(
        (
          await read(
            'SELECT "paymentMode","paymentStatus" FROM bookings WHERE id=$1',
            [id],
          )
        )[0],
      ).toMatchObject({ paymentMode: 'points', paymentStatus: 'pending' });
      expect(
        await getDb().query(
          'SELECT * FROM cash_commissions WHERE "bookingId"=$1',
          [id],
        ),
      ).toHaveLength(0);
    });
  });
}
