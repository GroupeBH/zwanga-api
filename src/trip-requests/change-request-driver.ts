import { ConflictException, NotFoundException } from '@nestjs/common';
import { EntityManager, In, QueryFailedError } from 'typeorm';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { BookingsService } from '../bookings/bookings.service';
import { lockTripBookingCreation } from '../bookings/bookable-trip-transaction';
import { Notification } from '../notifications/entities/notification.entity';
import { enqueueTransactionalNotification } from '../notifications/transactional-notification';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { ChangeRequestDriverDto } from './dto/change-request-driver.dto';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';
import { DriverOffer, DriverOfferStatus } from './entities/driver-offer.entity';
import { retireRequestInvitations } from './dispatch/retire-request-invitations';

/** Request -> booking creation gate -> ordered bookings -> trip, as in trip completion.
 * All mutations/outbox entries commit together. No Redis, push or provider calls here. */
export async function changeRequestDriver(
  database: EntityManager,
  passengerId: string,
  requestId: string,
  dto: ChangeRequestDriverDto,
  bookings: Pick<BookingsService, 'cancelUnpaidBookingForDriverChange'>,
) {
  return database
    .transaction(async (manager) => {
      await manager.query("SET LOCAL lock_timeout = '3s'");
      const request = await manager.findOne(TripRequest, {
        where: { id: requestId, passengerId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!request)
        throw new NotFoundException('Commande de trajet introuvable.');
      const eventKey = `request-driver-change:${requestId}:${dto.selectedDriverId}:${new Date(dto.selectedAt).toISOString()}`;
      // A retry after a lost HTTP response must not undo a later driver selection.
      if (await manager.exists(Notification, { where: { eventKey } }))
        return {
          changed: false,
          bookingIds: [] as string[],
          tripId: null as string | null,
        };
      if (
        request.status !== TripRequestStatus.DRIVER_SELECTED ||
        request.selectedDriverId !== dto.selectedDriverId ||
        !request.selectedAt ||
        request.selectedAt.getTime() !== new Date(dto.selectedAt).getTime()
      ) {
        throw new ConflictException({
          code: 'REQUEST_DRIVER_SELECTION_CHANGED',
          message:
            'Le conducteur sélectionné a changé. Actualisez la commande avant de réessayer.',
        });
      }

      const bookingIds: string[] = [];
      // Include a trip being prepared by the legacy start endpoint, before tripId is linked.
      const linked = request.tripId
        ? { id: request.tripId }
        : await manager.findOne(Trip, {
            where: {
              tripRequestId: requestId,
              status: In([
                TripStatus.PENDING,
                TripStatus.ACTIVE,
                TripStatus.COMPLETED,
              ]),
            },
          });
      let cancelledTripId: string | null = null;
      if (linked) {
        await lockTripBookingCreation(manager, linked.id);
        const reservations = await manager
          .getRepository(Booking)
          .createQueryBuilder('b')
          .addSelect(['b.rideDeclarations', 'b.rideEffectsPending'])
          .where('b.tripId = :tripId', { tripId: linked.id })
          .orderBy('b.id', 'ASC')
          .setLock('pessimistic_write')
          .getMany();
        const trip = await manager.findOne(Trip, {
          where: { id: linked.id },
          // Legacy boarding can lock trip -> booking. Never wait for its trip
          // lock while holding its booking; rollback and let the passenger retry.
          lock: { mode: 'pessimistic_write', onLocked: 'nowait' },
        });
        if (
          !trip ||
          trip.driverId !== dto.selectedDriverId ||
          ![TripStatus.PENDING, TripStatus.ACTIVE].includes(trip.status)
        )
          throw new ConflictException({
            code: 'REQUEST_DRIVER_CHANGE_TRIP_CLOSED',
            message: 'Ce trajet ne peut plus changer de conducteur.',
          });
        const own = reservations.filter(
          (b) =>
            b.passengerId === passengerId &&
            ![
              BookingStatus.CANCELLED,
              BookingStatus.REJECTED,
              BookingStatus.EXPIRED,
            ].includes(b.status),
        );
        for (const booking of own) {
          await bookings.cancelUnpaidBookingForDriverChange(
            manager,
            booking,
            trip,
          );
          bookingIds.push(booking.id);
        }
        // Closed reservations may still contain money or a boarding confirmation.
        if (
          !own.length &&
          reservations.some((b) => b.passengerId === passengerId)
        )
          throw new ConflictException({
            code: 'REQUEST_DRIVER_CHANGE_BOOKING_CLOSED',
            message:
              'Cette réservation est déjà clôturée. Actualisez la commande ou contactez l’assistance.',
          });
        const others = reservations.some(
          (b) =>
            b.passengerId !== passengerId &&
            [
              BookingStatus.PENDING,
              BookingStatus.ACCEPTED,
              BookingStatus.BOARDING_UNCERTAIN,
            ].includes(b.status),
        );
        if (trip.tripRequestId === requestId) {
          // Prevent acceptance recovery from reattaching the old driver to this request.
          await manager.update(Trip, trip.id, {
            tripRequestId: null,
            ...(trip.isPrivate && !others
              ? { status: TripStatus.CANCELLED }
              : {}),
          });
          if (trip.isPrivate && !others) cancelledTripId = trip.id;
        }
      }

      // Discovery, Redis candidates and manual acceptance share this durable exclusion policy.
      // No missed-ring penalty or synthetic driver refusal is recorded.
      await manager.query(
        `INSERT INTO trip_request_driver_refusals ("driverId", "requestId", reason)
      VALUES ($1,$2,'passenger_changed_driver') ON CONFLICT ("driverId", "requestId") DO NOTHING`,
        [dto.selectedDriverId, requestId],
      );
      await manager.update(
        DriverOffer,
        { tripRequestId: requestId, status: DriverOfferStatus.ACCEPTED },
        {
          status: DriverOfferStatus.CANCELLED,
          rejectionReason: 'passenger_changed_driver',
        },
      );
      await retireRequestInvitations(manager, requestId, true);
      await manager.query(
        `UPDATE trip_request_dispatch_offers SET status='cancelled'
      WHERE "requestId"=$1 AND status='accepted'`,
        [requestId],
      );
      await manager.query(
        `UPDATE notifications SET "isActive"=false
      WHERE "isActive"=true AND data->>'tripRequestId'=$1::text
        AND data->>'type' IN ('trip_request_accepted','trip_request_driver_overdue','offer_accepted')`,
        [requestId],
      );
      if (bookingIds.length)
        await manager.query(
          `UPDATE notifications SET "isActive"=false
        WHERE "isActive"=true AND data->>'bookingId'=ANY($1::text[])
          AND data->>'type' IN ('new_booking','booking_response')`,
          [bookingIds],
        );
      const now = new Date();
      await manager.update(TripRequest, requestId, {
        id: requestId,
        status: TripRequestStatus.PENDING,
        tripId: null,
        targetDriverId: null,
        targetDriverPriorityUntil: null,
        selectedDriverId: null,
        selectedVehicleId: null,
        selectedPricePerSeat: null,
        selectedDriverRequiresPassengerKyc: false,
        selectedAt: null,
        driverPickupOverdueNotifiedAt: null,
        expirationNotificationSent: false,
        dispatchCheckedAt: null,
        ...(request.departureDateMax <= now
          ? {
              departureDateMin: now,
              departureDateMax: new Date(now.getTime() + 30 * 60_000),
            }
          : {}),
      });
      await enqueueTransactionalNotification(manager, {
        eventKey,
        userId: passengerId,
        title: 'Recherche d’un autre conducteur',
        body: 'Votre demande est conservée. Nous recherchons un autre conducteur.',
        data: {
          type: 'trip_request_reopened',
          tripRequestId: requestId,
          reason: 'passenger_changed_driver',
        },
      });
      await enqueueTransactionalNotification(manager, {
        eventKey: `${eventKey}:driver`,
        userId: dto.selectedDriverId,
        title: 'Prise en charge annulée',
        body: 'Le passager a choisi de chercher un autre conducteur pour cette demande.',
        data: {
          type: 'trip_request_driver_changed',
          tripRequestId: requestId,
          previousTripId: linked?.id ?? null,
          cancelledTripId,
          bookingIds: JSON.stringify(bookingIds),
        },
      });
      return { changed: true, bookingIds, tripId: linked?.id ?? null };
    })
    .catch((error: unknown) => {
      const code =
        error instanceof QueryFailedError
          ? (error.driverError as { code?: unknown }).code
          : undefined;
      if (typeof code === 'string' && ['55P03', '40P01'].includes(code)) {
        throw new ConflictException({
          code: 'REQUEST_DRIVER_CHANGE_BUSY',
          message:
            'Une action sur le trajet est en cours. Actualisez la commande puis réessayez.',
        });
      }
      throw error;
    });
}
