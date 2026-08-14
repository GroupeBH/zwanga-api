import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTripInterruptionRequests1780000010000
  implements MigrationInterface
{
  name = 'AddTripInterruptionRequests1780000010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS postgis;`);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trip_interruption_reason_enum') THEN
          CREATE TYPE "trip_interruption_reason_enum" AS ENUM (
            'emergency',
            'health',
            'safety',
            'route_issue',
            'personal',
            'other'
          );
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trip_interruption_status_enum') THEN
          CREATE TYPE "trip_interruption_status_enum" AS ENUM (
            'pending',
            'confirmed',
            'rejected',
            'cancelled',
            'completed'
          );
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trip_interruption_confirmation_status_enum') THEN
          CREATE TYPE "trip_interruption_confirmation_status_enum" AS ENUM (
            'pending',
            'confirmed',
            'rejected'
          );
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS passenger_trip_interruption_requests (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tripId" uuid NOT NULL,
        "bookingId" uuid NOT NULL,
        "passengerId" uuid NOT NULL,
        reason "trip_interruption_reason_enum" NOT NULL DEFAULT 'other',
        note text,
        status "trip_interruption_status_enum" NOT NULL DEFAULT 'pending',
        "requestedLocation" geography(Point,4326),
        "requestedAt" timestamp NOT NULL DEFAULT now(),
        "confirmedAt" timestamp,
        "rejectedAt" timestamp,
        "cancelledAt" timestamp,
        "completedAt" timestamp,
        "confirmedByDriverId" uuid,
        "rejectedByDriverId" uuid,
        "rejectionReason" text,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_passenger_trip_interruptions_trip"
          FOREIGN KEY ("tripId") REFERENCES trips(id) ON DELETE CASCADE,
        CONSTRAINT "FK_passenger_trip_interruptions_booking"
          FOREIGN KEY ("bookingId") REFERENCES bookings(id) ON DELETE CASCADE,
        CONSTRAINT "FK_passenger_trip_interruptions_passenger"
          FOREIGN KEY ("passengerId") REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT "FK_passenger_trip_interruptions_confirmed_driver"
          FOREIGN KEY ("confirmedByDriverId") REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT "FK_passenger_trip_interruptions_rejected_driver"
          FOREIGN KEY ("rejectedByDriverId") REFERENCES users(id) ON DELETE SET NULL
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS driver_trip_interruption_requests (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tripId" uuid NOT NULL,
        "requestedByDriverId" uuid NOT NULL,
        reason "trip_interruption_reason_enum" NOT NULL DEFAULT 'other',
        note text,
        status "trip_interruption_status_enum" NOT NULL DEFAULT 'pending',
        "requestedLocation" geography(Point,4326),
        "requiredPassengerCount" integer NOT NULL DEFAULT 0,
        "confirmedPassengerCount" integer NOT NULL DEFAULT 0,
        "rejectedPassengerCount" integer NOT NULL DEFAULT 0,
        "requestedAt" timestamp NOT NULL DEFAULT now(),
        "confirmedAt" timestamp,
        "rejectedAt" timestamp,
        "cancelledAt" timestamp,
        "completedAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_driver_trip_interruptions_trip"
          FOREIGN KEY ("tripId") REFERENCES trips(id) ON DELETE CASCADE,
        CONSTRAINT "FK_driver_trip_interruptions_driver"
          FOREIGN KEY ("requestedByDriverId") REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS driver_trip_interruption_confirmations (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "requestId" uuid NOT NULL,
        "tripId" uuid NOT NULL,
        "bookingId" uuid NOT NULL,
        "passengerId" uuid NOT NULL,
        status "trip_interruption_confirmation_status_enum" NOT NULL DEFAULT 'pending',
        "confirmedAt" timestamp,
        "rejectedAt" timestamp,
        "rejectionReason" text,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_driver_trip_interruption_confirmations_request"
          FOREIGN KEY ("requestId") REFERENCES driver_trip_interruption_requests(id) ON DELETE CASCADE,
        CONSTRAINT "FK_driver_trip_interruption_confirmations_trip"
          FOREIGN KEY ("tripId") REFERENCES trips(id) ON DELETE CASCADE,
        CONSTRAINT "FK_driver_trip_interruption_confirmations_booking"
          FOREIGN KEY ("bookingId") REFERENCES bookings(id) ON DELETE CASCADE,
        CONSTRAINT "FK_driver_trip_interruption_confirmations_passenger"
          FOREIGN KEY ("passengerId") REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_passenger_trip_interruptions_booking_status"
      ON passenger_trip_interruption_requests ("bookingId", status);
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_passenger_trip_interruptions_one_pending"
      ON passenger_trip_interruption_requests ("bookingId")
      WHERE status = 'pending';
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_driver_trip_interruptions_trip_status"
      ON driver_trip_interruption_requests ("tripId", status);
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_driver_trip_interruptions_one_pending"
      ON driver_trip_interruption_requests ("tripId")
      WHERE status = 'pending';
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_driver_trip_interruption_confirmations_request"
      ON driver_trip_interruption_confirmations ("requestId");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_driver_trip_interruption_confirmations_trip_passenger"
      ON driver_trip_interruption_confirmations ("tripId", "passengerId");
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_driver_trip_interruption_confirmations_unique_booking"
      ON driver_trip_interruption_confirmations ("requestId", "bookingId");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS driver_trip_interruption_confirmations;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS driver_trip_interruption_requests;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS passenger_trip_interruption_requests;`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "trip_interruption_confirmation_status_enum";`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "trip_interruption_status_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "trip_interruption_reason_enum";`);
  }
}
