import { MigrationInterface, QueryRunner } from 'typeorm';

export class OperationalZones1780000131000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive)
      throw Error('Operational zones require a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    await q.query(`
      CREATE TABLE zone_catalog (id boolean PRIMARY KEY DEFAULT true CHECK (id), revision integer NOT NULL DEFAULT 0,
        "changedAt" timestamptz NOT NULL DEFAULT now());
      INSERT INTO zone_catalog(id) VALUES(true);
      CREATE TABLE zones (
        id uuid PRIMARY KEY, name varchar(100) NOT NULL, description varchar(1000) NOT NULL DEFAULT '',
        boundary geometry(MultiPolygon,4326) NOT NULL,
        active boolean NOT NULL DEFAULT true, priority integer NOT NULL DEFAULT 0,
        version integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CHECK (NOT ST_IsEmpty(boundary) AND ST_IsValid(boundary)),
        CHECK (priority BETWEEN -1000 AND 1000)
      );
      CREATE INDEX zones_boundary_gist ON zones USING gist(boundary) WHERE active;
      CREATE INDEX zones_geography_gist ON zones USING gist((boundary::geography)) WHERE active;
      CREATE INDEX zones_name_id ON zones(name,id);
      CREATE INDEX zones_trips_live ON trips(id) WHERE status IN ('upcoming','ongoing');
      CREATE INDEX zones_requests_live ON trip_requests(id) WHERE status IN ('pending','offers_received','driver_selected');
      CREATE INDEX zones_trips_updated ON trips("updatedAt");
      CREATE INDEX zones_requests_updated ON trip_requests("updatedAt");
      CREATE TABLE zone_assignments (
        id uuid PRIMARY KEY,
        "tripId" uuid UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
        "requestId" uuid UNIQUE REFERENCES trip_requests(id) ON DELETE CASCADE,
        "departureZoneId" uuid REFERENCES zones(id), "arrivalZoneId" uuid REFERENCES zones(id),
        "checkedAt" timestamptz NOT NULL DEFAULT now(), revision integer NOT NULL,
        monitor jsonb NOT NULL DEFAULT '{}',
        CHECK (("tripId" IS NULL) <> ("requestId" IS NULL))
      );
      CREATE INDEX zone_assignments_departure ON zone_assignments("departureZoneId");
      CREATE INDEX zone_assignments_arrival ON zone_assignments("arrivalZoneId");
      CREATE INDEX zone_assignments_checked ON zone_assignments("checkedAt",id);
      CREATE TABLE zone_events (
        id uuid PRIMARY KEY, "tripId" uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK(kind IN ('outside','returned')), revision integer NOT NULL,
        "observedAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE("tripId","observedAt",kind)
      );
      CREATE INDEX zone_events_recent ON zone_events("createdAt" DESC,id);
      CREATE TABLE zone_audit_logs (
        id uuid PRIMARY KEY, "zoneId" uuid NOT NULL REFERENCES zones(id), "actorId" uuid NOT NULL,
        version integer NOT NULL, snapshot jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE("zoneId",version)
      );
    `);
  }
  async down(q: QueryRunner): Promise<void> {
    // Do not silently destroy configured boundaries or operational evidence.
    const [{ used }] = await q.query(
      'SELECT EXISTS(SELECT 1 FROM zones) AS used',
    );
    if (used)
      throw Error(
        'Export and preserve zone configuration/audit before reverting.',
      );
    await q.query(`DROP TABLE zone_audit_logs, zone_events, zone_assignments, zones, zone_catalog;
      DROP INDEX zones_trips_live, zones_requests_live, zones_trips_updated, zones_requests_updated;`);
  }
}
