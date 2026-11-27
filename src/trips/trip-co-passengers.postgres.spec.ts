import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema } from 'typeorm';
import { ForbiddenException } from '@nestjs/common';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { Trip, TripStatus } from './entities/trip.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { TripCoPassengersService } from './trip-co-passengers.service';

const bin = process.env.CO_PASSENGERS_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'co-passengers on disposable PostgreSQL (no application database)',
  () => {
    const cluster = new IsolatedPostgres(bin!);
    let db: DataSource;
    let service: TripCoPassengersService;
    const tripId = randomUUID(),
      driverId = randomUUID(),
      viewerId = randomUUID(),
      fellowId = randomUUID();
    const ownBookingId = randomUUID(),
      fellowBookingId = randomUUID();

    beforeAll(async () => {
      const base = await cluster.start();
      db = await new DataSource({
        ...base.options,
        synchronize: true,
        entities: [
          new EntitySchema<Trip>({
            name: 'Trip',
            target: Trip,
            tableName: 'trips',
            columns: {
              id: { type: 'uuid', primary: true },
              driverId: { type: String },
              status: { type: String },
              tripRequestId: { type: 'uuid', nullable: true },
              isPrivate: { type: Boolean, default: false },
            },
            relations: {
              bookings: {
                type: 'one-to-many',
                target: 'Booking',
                inverseSide: 'trip',
              },
            },
          }),
          new EntitySchema<Booking>({
            name: 'Booking',
            target: Booking,
            tableName: 'bookings',
            columns: {
              id: { type: 'uuid', primary: true },
              tripId: { type: 'uuid' },
              passengerId: { type: String },
              status: { type: String },
              numberOfSeats: { type: Number },
              createdAt: { type: 'timestamptz', createDate: true },
            },
            indices: [{ columns: ['tripId', 'passengerId'] }],
            relations: {
              trip: {
                type: 'many-to-one',
                target: 'Trip',
                joinColumn: { name: 'tripId' },
                inverseSide: 'bookings',
              },
              passenger: {
                type: 'many-to-one',
                target: 'User',
                joinColumn: { name: 'passengerId' },
              },
            },
          }),
          new EntitySchema<User>({
            name: 'User',
            target: User,
            tableName: 'users',
            columns: {
              id: { type: String, primary: true },
              firstName: { type: String },
              lastName: { type: String },
              phone: { type: String },
              profilePicture: { type: String, nullable: true },
              isActive: { type: Boolean, default: true },
            },
          }),
        ],
      }).initialize();
      service = new TripCoPassengersService(db.getRepository(Trip));
    }, 90000);
    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      await cluster.stop();
    }, 45000);
    beforeEach(async () => {
      await db.query('TRUNCATE bookings, trips, users CASCADE');
      await db.getRepository(User).save(
        [viewerId, fellowId].map((id) => ({
          id,
          firstName: id === fellowId ? 'Exemple' : 'Lecteur',
          lastName: 'Confidentiel',
          phone: 'non-public',
        })),
      );
      await db.getRepository(Trip).save({
        id: tripId,
        driverId,
        status: TripStatus.PENDING,
        isPrivate: false,
      });
      await db.getRepository(Booking).save([
        {
          id: ownBookingId,
          tripId,
          passengerId: viewerId,
          status: BookingStatus.ACCEPTED,
          numberOfSeats: 1,
        },
        {
          id: fellowBookingId,
          tripId,
          passengerId: fellowId,
          status: BookingStatus.ACCEPTED,
          numberOfSeats: 2,
        },
      ]);
    });
    const list = () => service.list(tripId, viewerId);
    it('returns only the other confirmed reservation and the public field allowlist', async () => {
      expect(await list()).toEqual({
        tripId,
        participants: [
          {
            id: fellowBookingId,
            userId: fellowId,
            firstName: 'Exemple',
            avatarUrl: null,
            seats: 2,
          },
        ],
      });
    });
    it.each([
      BookingStatus.PENDING,
      BookingStatus.REJECTED,
      BookingStatus.CANCELLED,
      BookingStatus.NO_SHOW,
      BookingStatus.EXPIRED,
    ])(
      'revokes access immediately when the reader booking becomes %s',
      async (status) => {
        await list(); // No shared response cache can retain the previous grant.
        await db.getRepository(Booking).update(ownBookingId, { status });
        await expect(list()).rejects.toBeInstanceOf(ForbiddenException);
      },
    );
    it('denies an outsider, a different trip participant and a nonexistent trip', async () => {
      await expect(service.list(tripId, randomUUID())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.list(randomUUID(), viewerId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      const otherTripId = randomUUID();
      await db
        .getRepository(Trip)
        .save({ id: otherTripId, driverId, status: TripStatus.PENDING });
      await db
        .getRepository(Booking)
        .update(ownBookingId, { tripId: otherTripId });
      await expect(list()).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('excludes pending/refused/cancelled reservations without denying the remaining reader', async () => {
      for (const status of [
        BookingStatus.PENDING,
        BookingStatus.REJECTED,
        BookingStatus.CANCELLED,
        BookingStatus.NO_SHOW,
      ]) {
        await db.getRepository(Booking).update(fellowBookingId, { status });
        expect(await list()).toEqual({ tripId, participants: [] });
      }
    });
    it('allows an accepted passenger on an ongoing trip and completed participants on its history', async () => {
      await db
        .getRepository(Trip)
        .update(tripId, { status: TripStatus.ACTIVE });
      expect((await list()).participants).toHaveLength(1);
      await db
        .getRepository(Trip)
        .update(tripId, { status: TripStatus.COMPLETED });
      await db
        .getRepository(Booking)
        .update({ tripId }, { status: BookingStatus.COMPLETED });
      expect((await list()).participants).toHaveLength(1);
    });
    it('denies private, request-based and cancelled trips even to a participant', async () => {
      await db.getRepository(Trip).update(tripId, { isPrivate: true });
      await expect(list()).rejects.toBeInstanceOf(ForbiddenException);
      await db
        .getRepository(Trip)
        .update(tripId, { isPrivate: false, tripRequestId: randomUUID() });
      await expect(list()).rejects.toBeInstanceOf(ForbiddenException);
      await db
        .getRepository(Trip)
        .update(tripId, { tripRequestId: null, status: TripStatus.CANCELLED });
      await expect(list()).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('deduplicates join rows when the reader has multiple bookings, and anonymizes inactive profiles', async () => {
      await db.getRepository(Booking).save({
        id: randomUUID(),
        tripId,
        passengerId: viewerId,
        status: BookingStatus.ACCEPTED,
        numberOfSeats: 1,
      });
      await db.getRepository(User).update(fellowId, { isActive: false });
      expect((await list()).participants).toEqual([
        {
          id: fellowBookingId,
          userId: null,
          firstName: 'Passager',
          avatarUrl: null,
          seats: 2,
        },
      ]);
    });
    it('lets the trip owner read the same restricted representation without changing driver booking endpoints', async () => {
      expect((await service.list(tripId, driverId)).participants).toHaveLength(
        2,
      );
    });
  },
);
