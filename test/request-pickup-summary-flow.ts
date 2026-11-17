import type { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type { SequentialDispatchService } from '../src/trip-requests/dispatch/sequential-dispatch.service';
import type { DriverDispatchService } from '../src/trip-requests/dispatch/dispatch.service';
import {
  TripRequest,
  TripRequestStatus,
} from '../src/trip-requests/entities/trip-request.entity';
import type { User } from '../src/users/entities/user.entity';
import type { GoogleMapsService } from '../src/google-maps/google-maps.service';
import { requestPickupSummary } from '../src/trip-requests/request-pickup-summary';
import { Trip } from '../src/trips/entities/trip.entity';
import {
  Booking,
  BookingStatus,
} from '../src/bookings/entities/booking.entity';

type Context = {
  db: DataSource;
  relay: SequentialDispatchService;
  dispatch: DriverDispatchService;
  driver: () => Promise<User>;
  request: (immediate: boolean) => Promise<TripRequest>;
  offers: (id: string) => Promise<{ id: string; driverId: string }[]>;
};
export function requestPickupSummaryFlow(context: () => Context) {
  describe('pickup summary SQL', () => {
    const setup = async () => {
      const c = context(),
        driver = await c.driver(),
        request = await c.request(true);
      await c.relay.advance(request.id);
      const [offer] = await c.offers(request.id);
      await c.dispatch.respond(driver.id, offer.id, 'accept');
      const maps = {
        getDirections: jest
          .fn()
          .mockResolvedValue({
            routes: [{ legs: [{ distance: 2000, duration: 400 }] }],
          }),
      };
      const read = (userId: string) =>
        requestPickupSummary(
          c.db.manager,
          maps as unknown as GoogleMapsService,
          request.id,
          userId,
        );
      return { ...c, driver, request, read, maps };
    };
    it('works immediately without a trip, only for the selected driver and passenger', async () => {
      const c = await setup();
      expect(await c.read(c.driver.id)).toMatchObject({
        viewerRole: 'driver',
        estimate: { distanceMeters: 2000 },
      });
      expect(await c.read(c.request.passengerId)).toMatchObject({
        viewerRole: 'passenger',
        driver: { id: c.driver.id },
      });
      await expect(c.read(randomUUID())).rejects.toThrow();
      await c.db
        .getRepository(TripRequest)
        .update(c.request.id, { status: TripRequestStatus.CANCELLED });
      await expect(c.read(c.driver.id)).rejects.toThrow();
    });
    it('withholds stale coordinates and stops disclosure after boarding', async () => {
      const c = await setup();
      await c.db.query(
        `UPDATE driver_dispatch_presence SET "updatedAt"=now()-interval '3 minutes' WHERE "driverId"=$1`,
        [c.driver.id],
      );
      expect(await c.read(c.driver.id)).toMatchObject({
        status: 'waiting_location',
        estimate: null,
        driver: { position: null },
      });
      const trip = await c.db
        .getRepository(Trip)
        .save({
          driverId: c.driver.id,
          tripRequestId: c.request.id,
          departureLocation: 'Test',
          arrivalLocation: 'Test',
          departureDate: new Date(),
          totalSeats: 4,
          availableSeats: 3,
          pricePerSeat: 1000,
        });
      const booking = await c.db
        .getRepository(Booking)
        .save({
          tripId: trip.id,
          passengerId: c.request.passengerId,
          numberOfSeats: 1,
          status: BookingStatus.ACCEPTED,
        });
      await c.db
        .getRepository(TripRequest)
        .update(c.request.id, { tripId: trip.id });
      expect((await c.read(c.request.passengerId)).tripId).toBe(trip.id);
      await c.db.getRepository(Booking).update(booking.id, { pickedUp: true });
      await expect(c.read(c.driver.id)).rejects.toThrow();
    });
  });
}
