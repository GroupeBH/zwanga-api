import { MigrationInterface, QueryRunner } from 'typeorm';
export class FleetExternalPayments1780000126000 implements MigrationInterface {
  async up(q: QueryRunner) {
    if (!q.isTransactionActive)
      throw Error('Fleet payments require a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query(`ALTER TABLE fleet_registry_assignments
      ADD COLUMN "periodicAmountMinor" bigint,
      ADD COLUMN "paymentPeriod" text,
      ADD COLUMN sequence bigint GENERATED ALWAYS AS IDENTITY,
      ADD CONSTRAINT "CK_fleet_periodic_terms" CHECK (
        ("periodicAmountMinor" IS NULL AND "paymentPeriod" IS NULL) OR
        ("periodicAmountMinor" IS NOT NULL AND "paymentPeriod" IS NOT NULL AND
         "periodicAmountMinor" BETWEEN 100 AND 1000000000000 AND "periodicAmountMinor" % 100=0 AND
         "paymentPeriod" IN ('DAILY','WEEKLY','MONTHLY')));
      CREATE UNIQUE INDEX "UQ_fleet_assignment_sequence" ON fleet_registry_assignments(sequence);
      CREATE INDEX "IDX_fleet_assignment_vehicle_sequence" ON fleet_registry_assignments("vehicleId",sequence DESC);
      CREATE INDEX "IDX_fleet_assignment_driver_sequence" ON fleet_registry_assignments("driverId",sequence DESC);
      CREATE TABLE fleet_external_payments (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
        "assignmentId" uuid NOT NULL REFERENCES fleet_registry_assignments(id),
        "mutationId" uuid NOT NULL,
        "amountMinor" bigint NOT NULL CHECK("amountMinor" BETWEEN 100 AND 1000000000000 AND "amountMinor" % 100=0),
        "paidOn" date NOT NULL, reference varchar(160) NOT NULL CHECK(length(trim(reference)) BETWEEN 3 AND 160),
        "periodLabel" varchar(100) NOT NULL CHECK(length(trim("periodLabel")) BETWEEN 3 AND 100),
        status text NOT NULL DEFAULT 'DECLARED' CHECK(status IN ('DECLARED','CONFIRMED','REJECTED')),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "decidedAt" timestamptz, "decidedBy" uuid REFERENCES users(id), "decisionNote" varchar(300),
        UNIQUE("assignmentId","mutationId"),
        CHECK((status='DECLARED' AND "decidedAt" IS NULL AND "decidedBy" IS NULL AND "decisionNote" IS NULL)
          OR (status<>'DECLARED' AND "decidedAt" IS NOT NULL AND "decidedBy" IS NOT NULL)),
        CHECK(status<>'REJECTED' OR ("decisionNote" IS NOT NULL AND length(trim("decisionNote"))>=3)));
      CREATE INDEX "IDX_fleet_payment_history" ON fleet_external_payments("assignmentId",sequence DESC);
      CREATE INDEX "IDX_fleet_payment_actor" ON fleet_external_payments("decidedBy");`);
  }
  async down(q: QueryRunner) {
    if (!q.isTransactionActive)
      throw Error('Fleet payments require a transaction');
    if (
      (
        await q.query(
          'SELECT 1 FROM fleet_registry_assignments WHERE "periodicAmountMinor" IS NOT NULL LIMIT 1',
        )
      ).length ||
      (await q.query('SELECT 1 FROM fleet_external_payments LIMIT 1')).length
    )
      throw Error('Archive periodic contracts and payments before reverting');
    await q.query(`DROP TABLE fleet_external_payments;
      ALTER TABLE fleet_registry_assignments DROP CONSTRAINT "CK_fleet_periodic_terms",
      DROP COLUMN "periodicAmountMinor", DROP COLUMN "paymentPeriod", DROP COLUMN sequence`);
  }
}
