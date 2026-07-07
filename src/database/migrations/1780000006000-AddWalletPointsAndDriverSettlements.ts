import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWalletPointsAndDriverSettlements1780000006000
  implements MigrationInterface
{
  name = 'AddWalletPointsAndDriverSettlements1780000006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

    await queryRunner.query(`
      ALTER TABLE bookings
      DROP CONSTRAINT IF EXISTS "CHK_bookings_payment_mode";
    `);
    await queryRunner.query(`
      ALTER TABLE bookings
      ADD CONSTRAINT "CHK_bookings_payment_mode"
      CHECK ("paymentMode" IN ('electronic', 'cash', 'points'));
    `);

    await queryRunner.query(`
      ALTER TABLE trip_requests
      DROP CONSTRAINT IF EXISTS "CHK_trip_requests_payment_mode";
    `);
    await queryRunner.query(`
      ALTER TABLE trip_requests
      ADD CONSTRAINT "CHK_trip_requests_payment_mode"
      CHECK ("paymentMode" IN ('electronic', 'cash', 'points'));
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS wallet_accounts (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        type character varying(40) NOT NULL,
        balance numeric(12, 2) NOT NULL DEFAULT 0,
        currency character varying(8) NOT NULL DEFAULT 'CDF',
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_wallet_accounts_type"
          CHECK (type IN ('points')),
        CONSTRAINT "UQ_wallet_accounts_user_type"
          UNIQUE ("userId", type)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wallet_accounts_user_type"
      ON wallet_accounts ("userId", type);
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "accountId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "accountType" character varying(40) NOT NULL,
        type character varying(40) NOT NULL,
        amount numeric(12, 2) NOT NULL,
        "balanceAfter" numeric(12, 2) NOT NULL,
        currency character varying(8) NOT NULL DEFAULT 'CDF',
        "relatedEntityType" character varying(80),
        "relatedEntityId" uuid,
        "paymentTransactionId" uuid,
        description character varying(500),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_wallet_ledger_account"
          FOREIGN KEY ("accountId") REFERENCES wallet_accounts(id)
          ON DELETE CASCADE,
        CONSTRAINT "FK_wallet_ledger_payment"
          FOREIGN KEY ("paymentTransactionId") REFERENCES payment_transactions(id)
          ON DELETE SET NULL,
        CONSTRAINT "CHK_wallet_ledger_account_type"
          CHECK ("accountType" IN ('points')),
        CONSTRAINT "CHK_wallet_ledger_type"
          CHECK (type IN ('top_up', 'loyalty_reward', 'booking_payment', 'booking_refund')),
        CONSTRAINT "CHK_wallet_ledger_amount_not_zero"
          CHECK (amount <> 0)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wallet_ledger_entries_user_created"
      ON wallet_ledger_entries ("userId", "createdAt");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wallet_ledger_entries_related"
      ON wallet_ledger_entries ("relatedEntityType", "relatedEntityId");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wallet_ledger_entries_payment"
      ON wallet_ledger_entries ("paymentTransactionId");
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wallet_ledger_top_up_payment"
      ON wallet_ledger_entries ("paymentTransactionId", type)
      WHERE "paymentTransactionId" IS NOT NULL AND type = 'top_up';
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wallet_ledger_booking_type"
      ON wallet_ledger_entries ("userId", type, "relatedEntityType", "relatedEntityId")
      WHERE "relatedEntityType" = 'booking';
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS driver_earnings (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "bookingId" uuid NOT NULL,
        "tripId" uuid NOT NULL,
        "driverId" uuid NOT NULL,
        "passengerId" uuid NOT NULL,
        "paymentMode" character varying(30) NOT NULL,
        "grossAmount" numeric(12, 2) NOT NULL,
        "commissionRate" numeric(12, 2) NOT NULL,
        "commissionAmount" numeric(12, 2) NOT NULL,
        "netAmount" numeric(12, 2) NOT NULL,
        currency character varying(8) NOT NULL DEFAULT 'CDF',
        status character varying(40) NOT NULL DEFAULT 'available',
        "availableAt" timestamp,
        "paidAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_driver_earnings_booking" UNIQUE ("bookingId"),
        CONSTRAINT "FK_driver_earnings_booking"
          FOREIGN KEY ("bookingId") REFERENCES bookings(id)
          ON DELETE CASCADE,
        CONSTRAINT "CHK_driver_earnings_payment_mode"
          CHECK ("paymentMode" IN ('electronic', 'points')),
        CONSTRAINT "CHK_driver_earnings_status"
          CHECK (status IN ('available', 'paid', 'cancelled'))
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_driver_earnings_driver_status"
      ON driver_earnings ("driverId", status);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_driver_earnings_trip"
      ON driver_earnings ("tripId");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS driver_payouts (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "driverId" uuid NOT NULL,
        amount numeric(12, 2) NOT NULL,
        currency character varying(8) NOT NULL DEFAULT 'CDF',
        phone character varying(30) NOT NULL,
        status character varying(40) NOT NULL DEFAULT 'pending',
        "paymentTransactionId" uuid,
        "requestedAt" timestamp,
        "processedAt" timestamp,
        "failureReason" character varying(500),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_driver_payouts_payment"
          FOREIGN KEY ("paymentTransactionId") REFERENCES payment_transactions(id)
          ON DELETE SET NULL,
        CONSTRAINT "CHK_driver_payouts_status"
          CHECK (status IN ('pending', 'initiated', 'succeeded', 'failed', 'cancelled')),
        CONSTRAINT "CHK_driver_payouts_amount_positive"
          CHECK (amount > 0)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_driver_payouts_driver_status"
      ON driver_payouts ("driverId", status);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_driver_payouts_payment"
      ON driver_payouts ("paymentTransactionId");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS driver_payouts;`);
    await queryRunner.query(`DROP TABLE IF EXISTS driver_earnings;`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallet_accounts;`);

    await queryRunner.query(`
      ALTER TABLE trip_requests
      DROP CONSTRAINT IF EXISTS "CHK_trip_requests_payment_mode";
    `);
    await queryRunner.query(`
      ALTER TABLE trip_requests
      ADD CONSTRAINT "CHK_trip_requests_payment_mode"
      CHECK ("paymentMode" IN ('electronic', 'cash'));
    `);

    await queryRunner.query(`
      ALTER TABLE bookings
      DROP CONSTRAINT IF EXISTS "CHK_bookings_payment_mode";
    `);
    await queryRunner.query(`
      ALTER TABLE bookings
      ADD CONSTRAINT "CHK_bookings_payment_mode"
      CHECK ("paymentMode" IN ('electronic', 'cash'));
    `);
  }
}
