import { MigrationInterface, QueryRunner } from 'typeorm';

export class FleetDriverApplications1780000134000 implements MigrationInterface {
  async up(q: QueryRunner) {
    if (!q.isTransactionActive)
      throw new Error('Fleet applications require a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query(`CREATE TABLE fleet_driver_applications (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      "organizationId" uuid NOT NULL REFERENCES partner_organizations(id),
      "userId" uuid NOT NULL REFERENCES users(id),
      message varchar(2000) NOT NULL CHECK(length(trim(message)) BETWEEN 10 AND 2000),
      status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACCEPTED','REJECTED','WITHDRAWN')),
      "decisionNote" varchar(1000), "reviewedBy" uuid REFERENCES users(id),
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "reviewedAt" timestamptz,
      CHECK(status NOT IN ('ACCEPTED','REJECTED') OR ("reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL))
    );
    CREATE UNIQUE INDEX "UQ_fleet_application_open" ON fleet_driver_applications("organizationId","userId") WHERE status IN ('PENDING','ACCEPTED');
    CREATE INDEX "IDX_fleet_application_org_status" ON fleet_driver_applications("organizationId",status,"createdAt" DESC,id DESC);
    CREATE INDEX "IDX_fleet_application_user" ON fleet_driver_applications("userId","createdAt" DESC,id DESC);
    CREATE INDEX "IDX_fleet_application_reviewer" ON fleet_driver_applications("reviewedBy");
    CREATE TABLE fleet_application_events (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      "applicationId" uuid NOT NULL REFERENCES fleet_driver_applications(id),
      "actorId" uuid NOT NULL REFERENCES users(id), action text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX "IDX_fleet_application_event_application" ON fleet_application_events("applicationId","createdAt");
    CREATE INDEX "IDX_fleet_application_event_actor" ON fleet_application_events("actorId");`);
  }

  async down(q: QueryRunner) {
    if (!q.isTransactionActive)
      throw new Error('Fleet applications require a transaction');
    if (
      Number(
        (
          await q.query('SELECT count(*) count FROM fleet_driver_applications')
        )[0].count,
      )
    )
      throw new Error('Archive fleet applications before reverting');
    await q.query(
      'DROP TABLE fleet_application_events,fleet_driver_applications',
    );
  }
}
