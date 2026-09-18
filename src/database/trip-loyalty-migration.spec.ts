import { AddTripLoyaltyAndCashSubsidyEarnings1780000037000 } from './migrations/1780000037000-AddTripLoyaltyAndCashSubsidyEarnings';
import { databaseMigrations } from './migrations';
import { AddRideHistoryIndexes1780000036000 } from './migrations/1780000036000-AddRideHistoryIndexes';

describe('Trip loyalty/cash subsidy migration contract (no live database)', () => {
  const migration = new AddTripLoyaltyAndCashSubsidyEarnings1780000037000();

  it('registers the migration after the existing history migration', () => {
    expect(
      databaseMigrations[
        databaseMigrations.indexOf(AddRideHistoryIndexes1780000036000) + 1
      ],
    ).toBe(AddTripLoyaltyAndCashSubsidyEarnings1780000037000);
  });

  it('allows cash earnings and enforces one credit per user/trip/component without changing balances', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await migration.up({ query } as any);
    const statements = query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(statements).toContain(
      `CHECK ("paymentMode" IN ('electronic', 'points', 'cash'))`,
    );
    expect(statements).toContain(
      'VALIDATE CONSTRAINT "CHK_driver_earnings_payment_mode"',
    );
    expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements).toContain('"IDX_bookings_cash_subsidy_recovery"');
    expect(statements).toContain('ON bookings (id)');
    expect(statements).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wallet_ledger_trip_loyalty"',
    );
    expect(statements).toContain(
      '("userId", "relatedEntityType", "relatedEntityId")',
    );
    expect(statements).toContain("WHERE type = 'loyalty_reward'");
    expect(statements).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
  });

  it('refuses rollback before dropping constraints when new financial records exist', async () => {
    const query = jest
      .fn()
      .mockRejectedValueOnce(new Error('Rollback refused'));
    await expect(migration.down({ query } as any)).rejects.toThrow(
      'Rollback refused',
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('RAISE EXCEPTION');
    expect(query.mock.calls[0][0]).toContain('trip_loyalty_base');
    expect(query.mock.calls[0][0]).not.toMatch(/\bDELETE\b/i);
  });
});
