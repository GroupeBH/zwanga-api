import { MigrationInterface, QueryRunner } from 'typeorm';

export class RequestVehicleTypes1780000104000 implements MigrationInterface {
  name = 'RequestVehicleTypes1780000104000';

  async up(runner: QueryRunner): Promise<void> {
    // Additive, no table-wide rewrite: old rows fall back to vehicleType in reads.
    await runner.query(`ALTER TABLE trip_requests ADD COLUMN "vehicleTypes" text[];
      ALTER TABLE trip_requests ADD CONSTRAINT "CHK_request_vehicle_types" CHECK (
        "vehicleTypes" IS NULL OR (cardinality("vehicleTypes") BETWEEN 1 AND 3
          AND array_ndims("vehicleTypes") = 1 AND array_lower("vehicleTypes", 1) = 1
          AND array_position("vehicleTypes", NULL) IS NULL
          AND (cardinality("vehicleTypes") < 2 OR "vehicleTypes"[1] <> "vehicleTypes"[2])
          AND (cardinality("vehicleTypes") < 3 OR ("vehicleTypes"[1] <> "vehicleTypes"[3] AND "vehicleTypes"[2] <> "vehicleTypes"[3]))
          AND "vehicleTypes" <@ ARRAY['car','motorcycle_2_wheels','motorcycle_3_wheels']::text[]
          AND "vehicleType"::text = "vehicleTypes"[1])) NOT VALID;
      CREATE FUNCTION zwanga_request_vehicle_types_sync() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW."vehicleType" IS DISTINCT FROM OLD."vehicleType"
            AND NEW."vehicleTypes" IS NOT DISTINCT FROM OLD."vehicleTypes" THEN
            NEW."vehicleTypes" := ARRAY[NEW."vehicleType"::text];
          END IF;
        END IF;
        IF cardinality(NEW."vehicleTypes") > 0 THEN
          NEW."vehicleType" := NEW."vehicleTypes"[1]::vehicles_type_enum;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER request_vehicle_types_sync BEFORE INSERT OR UPDATE OF "vehicleType", "vehicleTypes"
        ON trip_requests FOR EACH ROW EXECUTE FUNCTION zwanga_request_vehicle_types_sync();`);
  }

  async down(runner: QueryRunner): Promise<void> {
    // Legacy primary choice is retained; additional choices are removed on rollback.
    await runner.query(`DROP TRIGGER request_vehicle_types_sync ON trip_requests;
      DROP FUNCTION zwanga_request_vehicle_types_sync();
      ALTER TABLE trip_requests DROP CONSTRAINT "CHK_request_vehicle_types", DROP COLUMN "vehicleTypes";`);
  }
}
