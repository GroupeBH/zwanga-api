import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTripShareLinks1780000007000 implements MigrationInterface {
  name = 'AddTripShareLinks1780000007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trip_share_links (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        token character varying(96) NOT NULL,
        "tripId" uuid NOT NULL,
        "bookingId" uuid,
        "ownerId" uuid NOT NULL,
        "recipientEmail" character varying(160),
        "recipientName" character varying(120),
        message text,
        "expiresAt" timestamp NOT NULL,
        "revokedAt" timestamp,
        "lastAccessedAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_trip_share_links_token" UNIQUE (token),
        CONSTRAINT "FK_trip_share_links_trip"
          FOREIGN KEY ("tripId") REFERENCES trips(id)
          ON DELETE CASCADE,
        CONSTRAINT "FK_trip_share_links_booking"
          FOREIGN KEY ("bookingId") REFERENCES bookings(id)
          ON DELETE CASCADE,
        CONSTRAINT "FK_trip_share_links_owner"
          FOREIGN KEY ("ownerId") REFERENCES users(id)
          ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_trip_share_links_trip"
      ON trip_share_links ("tripId");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_trip_share_links_booking"
      ON trip_share_links ("bookingId");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_trip_share_links_owner"
      ON trip_share_links ("ownerId");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_trip_share_links_expires"
      ON trip_share_links ("expiresAt");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS trip_share_links;`);
  }
}
