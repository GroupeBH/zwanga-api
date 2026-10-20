import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { User } from '../users/entities/user.entity';
import { assertDriverCanOperate } from '../users/driver-activation';
import { BookingsService } from '../bookings/bookings.service';
import { Booking } from '../bookings/entities/booking.entity';
import { enqueueTransactionalNotification } from '../notifications/transactional-notification';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';
import { DriverOffer, DriverOfferStatus } from './entities/driver-offer.entity';
import {
  assertRequestSnapshot,
  assertUnassignedRequest,
} from './request-edit-policy';
import { assertSharedTripAvailable } from './shared-trip-policy';
import { NEARBY_DRIVER_RADIUS_METERS } from './dispatch/nearby-driver-policy';

@Injectable()
export class SharedTripOffersService {
  constructor(
    private readonly db: DataSource,
    private readonly bookings: BookingsService,
  ) {}

  private async validate(
    manager: EntityManager,
    request: TripRequest,
    trip: Trip,
    driverId: string,
  ) {
    const driver = await manager.findOneBy(User, { id: driverId });
    if (!driver) throw new NotFoundException('Conducteur introuvable.');
    await assertDriverCanOperate(manager, driver);
    const vehicle = trip.vehicleId
      ? await manager.findOneBy(Vehicle, { id: trip.vehicleId })
      : null;
    assertSharedTripAvailable(request, trip, vehicle, driverId);
    // Active navigation is the authoritative position. Otherwise retain the
    // last known discovery position, as in the existing dispatch policy.
    const [location] = await manager.query(
      `SELECT ST_DWithin(
      COALESCE(t."currentLocation", p.position), r."departurePoint", $3) AS nearby
      FROM trips t JOIN trip_requests r ON r.id = $2
      LEFT JOIN driver_dispatch_presence p ON p."driverId" = t."driverId"
      WHERE t.id = $1`,
      [trip.id, request.id, NEARBY_DRIVER_RADIUS_METERS],
    );
    if (!location?.nearby)
      throw new ConflictException(
        'Le point de prise en charge est trop éloigné ou votre position est indisponible.',
      );
  }

  /** Only the authenticated driver's own trip; never exposes other passengers. */
  async context(driverId: string, requestId: string) {
    const request = await this.db.manager.findOneBy(TripRequest, {
      id: requestId,
    });
    if (!request || request.passengerId === driverId)
      throw new NotFoundException('Commande introuvable.');
    const trip = await this.db.manager.findOneBy(Trip, {
      driverId,
      status: TripStatus.ACTIVE,
    });
    if (!trip) return { hasOngoingTrip: false, trip: null, reason: null };
    try {
      await this.validate(this.db.manager, request, trip, driverId);
      return {
        hasOngoingTrip: true,
        trip: {
          id: trip.id,
          availableSeats: trip.availableSeats,
          pricePerSeat: trip.isFree ? 0 : Number(trip.pricePerSeat),
          arrivalLocation: trip.arrivalLocation,
        },
        reason: null,
      };
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      return { hasOngoingTrip: true, trip: null, reason: error.message };
    }
  }

  async propose(driverId: string, requestId: string, tripId: string) {
    return this.db.transaction(async (manager) => {
      // Consistent order with request edits/acceptance: request -> trip -> offers.
      const request = await manager.findOne(TripRequest, {
        where: { id: requestId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!request) throw new NotFoundException('Commande introuvable.');
      const trip = await manager.findOne(Trip, {
        where: { id: tripId, driverId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!trip) throw new NotFoundException('Trajet introuvable.');
      await this.validate(manager, request, trip, driverId);
      const previous = await manager.findOneBy(DriverOffer, {
        tripRequestId: requestId,
        driverId,
        status: In([DriverOfferStatus.PENDING, DriverOfferStatus.ACCEPTED]),
      });
      if (previous?.existingTripId === tripId)
        return { offerId: previous.id, status: previous.status };
      if (previous)
        throw new ConflictException(
          'Vous avez déjà une offre pour cette commande.',
        );
      const offer = await manager.save(
        DriverOffer,
        manager.create(DriverOffer, {
          tripRequestId: requestId,
          driverId,
          vehicleId: trip.vehicleId,
          existingTripId: trip.id,
          availableSeats: trip.availableSeats,
          pricePerSeat: trip.isFree ? 0 : Number(trip.pricePerSeat),
          proposedDepartureDate: new Date(
            Math.max(Date.now(), request.departureDateMin.getTime()),
          ),
          requiresPassengerKyc: trip.requiresPassengerKyc,
          status: DriverOfferStatus.PENDING,
          departurePoint: request.departurePoint,
          arrivalPoint: request.arrivalPoint,
          departureReference: request.departureReference,
          arrivalReference: request.arrivalReference,
          message:
            'Rejoindre un trajet déjà en cours, partagé avec d’autres passagers. Votre accord est nécessaire.',
        }),
      );
      // Immediate requests keep receiving independent invitations until the
      // passenger actually accepts a shared offer.
      if (!request.immediateDispatch)
        await manager.update(TripRequest, requestId, {
          status: TripRequestStatus.OFFERS_RECEIVED,
        });
      await enqueueTransactionalNotification(manager, {
        eventKey: `shared-trip-offer:${offer.id}`,
        userId: request.passengerId,
        title: 'Proposition de trajet partagé',
        body: 'Un conducteur déjà en trajet peut vous accueillir. Consultez le tarif et acceptez uniquement si vous souhaitez partager le trajet.',
        data: {
          type: 'driver_offer',
          tripRequestId: requestId,
          offerId: offer.id,
          sharedTrip: true,
          driverId,
          pricePerSeat: Number(offer.pricePerSeat),
        },
      });
      return { offerId: offer.id, status: offer.status };
    });
  }

  async accept(
    passengerId: string,
    requestId: string,
    offerId: string,
    consent: boolean,
  ) {
    if (consent !== true)
      throw new BadRequestException({
        code: 'SHARED_TRIP_CONSENT_REQUIRED',
        message:
          'Votre accord explicite est nécessaire pour rejoindre un trajet partagé.',
      });
    const request = await this.db.manager.findOneBy(TripRequest, {
      id: requestId,
      passengerId,
    });
    const offer = await this.db.manager.findOneBy(DriverOffer, {
      id: offerId,
      tripRequestId: requestId,
    });
    if (!request || !offer?.existingTripId)
      throw new NotFoundException('Proposition introuvable.');
    const committed = () =>
      this.committedSelection(passengerId, requestId, offerId);
    const previous = await committed();
    if (previous) return previous;
    assertUnassignedRequest(request);
    if (offer.status !== DriverOfferStatus.PENDING)
      throw new ConflictException('Cette proposition n’est plus disponible.');
    try {
      const booking = await this.bookings.create(
        passengerId,
        {
          tripId: offer.existingTripId,
          numberOfSeats: request.numberOfSeats,
          passengerOrigin: request.departureLocation,
          passengerDestination: request.arrivalLocation,
          passengerOriginReference: request.departureReference ?? undefined,
          passengerDestinationReference: request.arrivalReference ?? undefined,
          passengerOriginCoordinates: this.coordinates(request.departurePoint),
          passengerDestinationCoordinates: this.coordinates(
            request.arrivalPoint,
          ),
          paymentMode: request.paymentMode,
        },
        {
          lockRequest: async (manager) => {
            const current = await manager.findOne(TripRequest, {
              where: { id: requestId, passengerId },
              lock: { mode: 'pessimistic_write' },
            });
            assertRequestSnapshot(current, request);
            assertUnassignedRequest(current!);
          },
          validate: async (manager, trip) => {
            const currentOffer = await manager.findOneBy(DriverOffer, {
              id: offerId,
              status: DriverOfferStatus.PENDING,
            });
            if (
              !currentOffer ||
              currentOffer.existingTripId !== trip.id ||
              Number(currentOffer.pricePerSeat) !==
                (trip.isFree ? 0 : Number(trip.pricePerSeat)) ||
              currentOffer.requiresPassengerKyc !== trip.requiresPassengerKyc
            ) {
              throw new ConflictException(
                'La proposition a changé. Actualisez la commande.',
              );
            }
            await this.validate(manager, request, trip, offer.driverId);
          },
          selected: async (manager, booking) => {
            const now = new Date();
            await manager.update(DriverOffer, offerId, {
              status: DriverOfferStatus.ACCEPTED,
              acceptedAt: now,
              sharedTripConsentAt: now,
              sharedBookingId: booking.id,
            });
            await manager.update(
              DriverOffer,
              { tripRequestId: requestId, status: DriverOfferStatus.PENDING },
              { status: DriverOfferStatus.REJECTED, rejectedAt: now },
            );
            await manager.update(TripRequest, requestId, {
              status: TripRequestStatus.DRIVER_SELECTED,
              selectedDriverId: offer.driverId,
              selectedVehicleId: offer.vehicleId,
              selectedPricePerSeat: offer.pricePerSeat,
              selectedDriverRequiresPassengerKyc: offer.requiresPassengerKyc,
              selectedAt: now,
              driverPickupOverdueNotifiedAt: null,
              tripId: booking.tripId,
            });
            await manager.query(
              `UPDATE trip_request_dispatch_offers SET status = 'cancelled'
            WHERE "requestId" = $1 AND status = 'pending'`,
              [requestId],
            );
            for (const userId of [passengerId, offer.driverId])
              await enqueueTransactionalNotification(manager, {
                eventKey: `shared-trip-accepted:${offer.id}:${userId}`,
                userId,
                title: 'Trajet partagé confirmé',
                body:
                  userId === passengerId
                    ? 'Votre place est confirmée. Le conducteur vient vous chercher.'
                    : 'Le passager a accepté de partager votre trajet. Retrouvez sa prise en charge dans le trajet en cours.',
                data: {
                  type:
                    userId === passengerId
                      ? 'trip_request_accepted'
                      : 'offer_accepted',
                  tripRequestId: requestId,
                  tripId: booking.tripId,
                  bookingId: booking.id,
                  offerId: offer.id,
                  driverId: offer.driverId,
                  passengerId,
                  sharedTrip: true,
                },
              });
          },
        },
      );
      return {
        tripId: booking.tripId,
        bookingId: booking.id,
        status: 'accepted',
      };
    } catch (error) {
      // Retry/concurrent tap after commit must never create a second booking.
      const saved = await committed();
      if (saved) return saved;
      throw error;
    }
  }

  async decline(passengerId: string, requestId: string, offerId: string) {
    return this.db.transaction(async (manager) => {
      const request = await manager.findOne(TripRequest, {
        where: { id: requestId, passengerId },
        lock: { mode: 'pessimistic_write' },
      });
      const offer = await manager.findOneBy(DriverOffer, {
        id: offerId,
        tripRequestId: requestId,
      });
      if (!request || !offer?.existingTripId)
        throw new NotFoundException('Proposition introuvable.');
      if (offer.status === DriverOfferStatus.REJECTED)
        return { status: 'rejected' };
      assertUnassignedRequest(request);
      if (offer.status !== DriverOfferStatus.PENDING)
        throw new ConflictException('Cette proposition a déjà été traitée.');
      await manager.update(DriverOffer, offerId, {
        status: DriverOfferStatus.REJECTED,
        rejectedAt: new Date(),
      });
      return { status: 'rejected' };
    });
  }

  private async committedSelection(
    passengerId: string,
    requestId: string,
    offerId: string,
  ) {
    const offer = await this.db.manager.findOneBy(DriverOffer, {
      id: offerId,
      tripRequestId: requestId,
      status: DriverOfferStatus.ACCEPTED,
    });
    if (!offer?.sharedBookingId || !offer.sharedTripConsentAt) return null;
    const booking = await this.db.manager.findOneBy(Booking, {
      id: offer.sharedBookingId,
      passengerId,
    });
    return booking
      ? { tripId: booking.tripId, bookingId: booking.id, status: 'accepted' }
      : null;
  }

  private coordinates(point: TripRequest['departurePoint']) {
    return point
      ? { latitude: point.coordinates[1], longitude: point.coordinates[0] }
      : undefined;
  }
}
