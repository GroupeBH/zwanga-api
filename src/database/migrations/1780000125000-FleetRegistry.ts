import { MigrationInterface, QueryRunner } from 'typeorm';
export class FleetRegistry1780000125000 implements MigrationInterface {
  async up(q: QueryRunner) {
    if (!q.isTransactionActive)
      throw Error('Fleet registry requires a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query(`CREATE TABLE fleet_registry_vehicles (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"organizationId" uuid NOT NULL REFERENCES partner_organizations(id),
      plate varchar(30) NOT NULL UNIQUE,brand varchar(80) NOT NULL,model varchar(80) NOT NULL,color varchar(50) NOT NULL,
      seats integer NOT NULL CHECK(seats BETWEEN 1 AND 60),"createdAt" timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'SUBMITTED' CHECK(status IN ('SUBMITTED','AVAILABLE','PAUSED')),
      "appVehicleId" uuid UNIQUE REFERENCES vehicles(id),"verificationReference" text,"verifiedAt" timestamptz,
      CHECK(status<>'AVAILABLE' OR ("appVehicleId" IS NOT NULL AND "verifiedAt" IS NOT NULL AND "verificationReference" IS NOT NULL)));
      CREATE INDEX "IDX_fleet_registry_org" ON fleet_registry_vehicles("organizationId","createdAt",id);
      CREATE TABLE fleet_registry_assignments (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"vehicleId" uuid NOT NULL REFERENCES fleet_registry_vehicles(id),"driverId" uuid NOT NULL REFERENCES users(id),
        status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACTIVE','ENDED','CANCELLED')),
        terms text NOT NULL,"requestedAt" timestamptz NOT NULL DEFAULT now(),"acceptedAt" timestamptz,"endedAt" timestamptz,
        CHECK(status<>'ACTIVE' OR "acceptedAt" IS NOT NULL));
      CREATE UNIQUE INDEX "UQ_fleet_registry_assignment_vehicle" ON fleet_registry_assignments("vehicleId") WHERE status IN ('PENDING','ACTIVE');
      CREATE UNIQUE INDEX "UQ_fleet_registry_assignment_driver" ON fleet_registry_assignments("driverId") WHERE status IN ('PENDING','ACTIVE');
      CREATE INDEX "IDX_fleet_registry_assignment_history" ON fleet_registry_assignments("vehicleId","requestedAt",id);
      CREATE INDEX "IDX_fleet_registry_driver_history" ON fleet_registry_assignments("driverId","requestedAt",id);
      CREATE TABLE fleet_registry_events(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"vehicleId" uuid NOT NULL REFERENCES fleet_registry_vehicles(id),"actorId" uuid NOT NULL REFERENCES users(id),action text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE INDEX "IDX_fleet_registry_events_vehicle" ON fleet_registry_events("vehicleId","createdAt");
      CREATE INDEX "IDX_fleet_registry_events_actor" ON fleet_registry_events("actorId");`);
  }
  async down(q: QueryRunner) {
    if (!q.isTransactionActive)
      throw Error('Fleet registry requires a transaction');
    if (
      Number(
        (await q.query('SELECT count(*) count FROM fleet_registry_vehicles'))[0]
          .count,
      )
    )
      throw Error('Archive fleet records before reverting');
    await q.query(
      'DROP TABLE fleet_registry_events,fleet_registry_assignments,fleet_registry_vehicles',
    );
  }
}
