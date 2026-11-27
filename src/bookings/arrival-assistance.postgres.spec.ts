import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { Booking } from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { ArrivalAssistance1780000141000 } from '../database/migrations/1780000141000-ArrivalAssistance';
import { ArrivalAssistanceService } from './arrival-assistance.service';
import { RideDeclarationsService } from '../ride-declarations/ride-declarations.service';
import { isRideProgressDeliverable } from '../notifications/ride-progress-delivery';

// Fresh loopback cluster only; never loads .env or application connection URLs.
const bin = process.env.ARRIVAL_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'arrival assistance atomicity on disposable PostgreSQL',
  () => {
    const cluster = new IsolatedPostgres(bin!);
    let db: DataSource;
    const tripId = randomUUID(),
      bookingId = randomUUID(),
      passengerId = randomUUID(),
      driverId = randomUUID();
    const nullableTime = { type: 'timestamptz' as const, nullable: true };
    const boolean = { type: Boolean, default: false };
    const json = { type: 'jsonb' as const, nullable: true };
    beforeAll(async () => {
      const base = await cluster.start();
      db = await new DataSource({
        ...base.options,
        synchronize: true,
        entities: [
          new EntitySchema({
            name: 'Trip',
            target: Trip,
            tableName: 'trips',
            columns: {
              id: { type: 'uuid', primary: true },
              driverId: { type: 'uuid' },
              tripRequestId: { type: String, nullable: true },
              status: { type: String },
              startedAt: nullableTime,
              lastLocationUpdateAt: nullableTime,
              currentLocation: json,
              arrivalPoint: json,
            },
          }),
          new EntitySchema<Booking>({
            name: 'Booking',
            target: Booking,
            tableName: 'bookings',
            columns: {
              id: { type: 'uuid', primary: true },
              tripId: { type: 'uuid' },
              passengerId: { type: 'uuid' },
              status: { type: String },
              pickedUp: boolean,
              droppedOff: boolean,
              pickedUpConfirmedByPassenger: boolean,
              droppedOffConfirmedByPassenger: boolean,
              pickedUpAt: nullableTime,
              droppedOffAt: nullableTime,
              pickedUpConfirmedAt: nullableTime,
              droppedOffConfirmedAt: nullableTime,
              pickupDetectionMethod: { type: String, nullable: true },
              dropoffDetectionMethod: { type: String, nullable: true },
              passengerDestinationPoint: json,
              arrivalPrompt: { ...json, update: false },
              rideDeclarations: {
                type: 'jsonb',
                select: false,
                default: () => "'{}'::jsonb",
              },
              rideEffectsPending: {
                type: 'jsonb',
                select: false,
                default: () => "'[]'::jsonb",
              },
              rideEffectsVersion: { type: Number, select: false, default: 0 },
              rideEffectsRetryAt: { ...nullableTime, select: false },
            },
            relations: {
              trip: {
                type: 'many-to-one',
                target: 'Trip',
                joinColumn: { name: 'tripId' },
              },
            },
          }),
          new EntitySchema({
            name: 'Notification',
            target: Notification,
            tableName: 'notifications',
            columns: {
              id: {
                type: 'uuid',
                primary: true,
                default: () => 'gen_random_uuid()',
              },
              eventKey: { type: String, unique: true },
              userId: { type: String },
              fcmToken: { type: String },
              title: { type: String },
              body: { type: String },
              data: json,
              isAutomatic: boolean,
              status: { type: String },
              errorMessage: { type: String, nullable: true },
            },
          }),
        ],
      }).initialize();
      await db.query(
        'CREATE TABLE users(id uuid PRIMARY KEY, "isActive" boolean, status text)',
      );
      // Exercise the actual additive migration, then use its column in real transactions.
      await db.query('ALTER TABLE bookings DROP COLUMN "arrivalPrompt"');
      await db.transaction((manager) =>
        new ArrivalAssistance1780000141000().up(manager.queryRunner!),
      );
    }, 90000);
    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      await cluster.stop();
    }, 45000);
    beforeEach(async () => {
      await db.query('TRUNCATE bookings, trips, notifications, users CASCADE');
      await db.query(
        "INSERT INTO users VALUES ($1,true,'active'),($2,true,'active')",
        [passengerId, driverId],
      );
      const now = new Date();
      await db.getRepository(Trip).insert({
        id: tripId,
        driverId,
        tripRequestId: 'request',
        status: 'ongoing' as any,
        startedAt: new Date(now.getTime() - 600000),
        lastLocationUpdateAt: now,
        arrivalPoint: { type: 'Point', coordinates: [15.3, -4.3] },
        currentLocation: {
          type: 'Point',
          coordinates: [15.3, -4.3 + 70 / 111195],
        },
      });
      await db.getRepository(Booking).insert({
        id: bookingId,
        tripId,
        passengerId,
        status: 'accepted' as any,
        pickedUp: true,
        pickedUpAt: new Date(now.getTime() - 600000),
      });
    });
    async function setup() {
      const trip = (await db.getRepository(Trip).findOneBy({ id: tripId }))!;
      const observation = {
        longitude: 15.3,
        latitude: trip.currentLocation!.coordinates[1],
        recordedAt: trip.lastLocationUpdateAt!.toISOString(),
        accuracyMeters: 5,
        speedMetersPerSecond: 0,
        headingDegrees: null,
      };
      const locations = {
        getDriverLocationHistory: async () => ({ current: observation }),
      };
      const assistance = new ArrivalAssistanceService(
        db,
        {} as any,
        locations as any,
      );
      const followup = {
        validateManualRidePassenger: jest.fn(),
        invalidateManualRideCaches: jest.fn().mockResolvedValue(undefined),
        finishManualRideEffects: jest.fn(),
      };
      return {
        assistance,
        observation,
        service: new RideDeclarationsService(db, followup as any, assistance),
      };
    }
    it('concurrent replicas create one proposal and exactly two outbox notifications', async () => {
      const h = await setup();
      await Promise.all([
        h.assistance['propose'](bookingId, tripId, h.observation),
        h.assistance['propose'](bookingId, tripId, h.observation),
      ]);
      const booking = (await db
        .getRepository(Booking)
        .findOneBy({ id: bookingId }))!;
      expect(booking.arrivalPrompt?.id).toBeDefined();
      expect(booking.droppedOff).toBe(false);
      const notices = await db.getRepository(Notification).find();
      expect(notices).toHaveLength(2);
      expect(await isRideProgressDeliverable(db.manager, notices[0])).toBe(
        true,
      );
      // An unrelated stale entity save cannot overwrite the prompt.
      booking.arrivalPrompt = null;
      await db.getRepository(Booking).save(booking);
      expect(
        (await db.getRepository(Booking).findOneBy({ id: bookingId }))!
          .arrivalPrompt,
      ).not.toBeNull();
    });
    it('lost consent responses/concurrent retries cause one transition, and suppress the old proposal', async () => {
      const h = await setup();
      await h.assistance['propose'](bookingId, tripId, h.observation);
      const prompt = (await db
        .getRepository(Booking)
        .findOneBy({ id: bookingId }))!.arrivalPrompt!;
      const dto = {
        actorUserId: passengerId,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        stage: 'dropoff' as const,
        decision: 'confirm' as const,
        arrivalPromptId: prompt.id,
      };
      const results = await Promise.all([
        h.service.declare(bookingId, passengerId, dto),
        h.service.declare(bookingId, passengerId, dto),
      ]);
      expect(
        results.every((result) => result.dropoff.status === 'confirmed'),
      ).toBe(true);
      const [row] = await db.query(
        'SELECT status,"rideEffectsVersion","rideEffectsPending","arrivalPrompt","dropoffDetectionMethod" FROM bookings WHERE id=$1',
        [bookingId],
      );
      expect(row).toMatchObject({
        status: 'completed',
        rideEffectsVersion: 1,
        rideEffectsPending: ['dropoff'],
        dropoffDetectionMethod: 'manual_passenger_near_destination',
      });
      expect(row.arrivalPrompt.acceptedAt).toBeDefined();
      const notice = (await db.getRepository(Notification).find())[0];
      expect(await isRideProgressDeliverable(db.manager, notice)).toBe(false);
    });
    it('a cancelled locked trip cannot be completed through an otherwise valid prompt', async () => {
      const h = await setup();
      await h.assistance['propose'](bookingId, tripId, h.observation);
      const prompt = (await db
        .getRepository(Booking)
        .findOneBy({ id: bookingId }))!.arrivalPrompt!;
      await db.query("UPDATE trips SET status='cancelled' WHERE id=$1", [
        tripId,
      ]);
      await expect(
        h.service.declare(bookingId, passengerId, {
          actorUserId: passengerId,
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          stage: 'dropoff',
          decision: 'confirm',
          arrivalPromptId: prompt.id,
        }),
      ).rejects.toThrow();
      const [row] = await db.query(
        'SELECT status,"rideEffectsVersion" FROM bookings WHERE id=$1',
        [bookingId],
      );
      expect(row).toEqual({ status: 'accepted', rideEffectsVersion: 0 });
    });
    it('simultaneous driver confirmation and passenger consent share one terminal transition', async () => {
      const h = await setup();
      await h.assistance['propose'](bookingId, tripId, h.observation);
      const prompt = (await db
        .getRepository(Booking)
        .findOneBy({ id: bookingId }))!.arrivalPrompt!;
      const event = {
        occurredAt: new Date().toISOString(),
        stage: 'dropoff' as const,
        decision: 'confirm' as const,
      };
      const results = await Promise.all([
        h.service.declare(bookingId, driverId, {
          ...event,
          actorUserId: driverId,
          eventId: randomUUID(),
        }),
        h.service.declare(bookingId, passengerId, {
          ...event,
          actorUserId: passengerId,
          eventId: randomUUID(),
          arrivalPromptId: prompt.id,
        }),
      ]);
      expect(results.every((r) => r.dropoff.status === 'confirmed')).toBe(true);
      const [row] = await db.query(
        'SELECT "rideEffectsVersion", "dropoffDetectionMethod" FROM bookings WHERE id=$1',
        [bookingId],
      );
      expect(row.rideEffectsVersion).toBe(1);
      expect([
        'manual_driver_confirmation',
        'manual_passenger_near_destination',
      ]).toContain(row.dropoffDetectionMethod);
    });
    it('withholds a queued proposal after a dispute or its expiration', async () => {
      const h = await setup();
      await h.assistance['propose'](bookingId, tripId, h.observation);
      const notice = (await db.getRepository(Notification).find())[0];
      await db.query(
        'UPDATE bookings SET "rideDeclarations"=$2::jsonb WHERE id=$1',
        [
          bookingId,
          JSON.stringify({ dropoff: { driver: { decision: 'reject' } } }),
        ],
      );
      expect(await isRideProgressDeliverable(db.manager, notice)).toBe(false);
      await db.query(
        'UPDATE bookings SET "rideDeclarations"=\'{}\'::jsonb, "arrivalPrompt"=jsonb_set("arrivalPrompt",\'{expiresAt}\',to_jsonb(CURRENT_TIMESTAMP-INTERVAL \'1 second\')) WHERE id=$1',
        [bookingId],
      );
      expect(await isRideProgressDeliverable(db.manager, notice)).toBe(false);
    });
    it('notification persistence failure rolls back the proposal', async () => {
      const h = await setup();
      await db.query(
        "ALTER TABLE notifications ADD CONSTRAINT test_refuse_outbox CHECK (title='refused')",
      );
      try {
        await expect(
          h.assistance['propose'](bookingId, tripId, h.observation),
        ).rejects.toThrow();
        expect(
          (await db.getRepository(Booking).findOneBy({ id: bookingId }))!
            .arrivalPrompt,
        ).toBeNull();
        expect(await db.getRepository(Notification).count()).toBe(0);
      } finally {
        await db.query(
          'ALTER TABLE notifications DROP CONSTRAINT test_refuse_outbox',
        );
      }
    });
  },
);
