import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { User, UserStatus } from './entities/user.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { Booking, BookingPaymentStatus, BookingStatus } from '../bookings/entities/booking.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { RecurringTripTemplate, RecurringTripTemplateStatus } from '../trips/entities/recurring-trip-template.entity';
import { TripRequest, TripRequestStatus } from '../trip-requests/entities/trip-request.entity';
import { DriverOffer, DriverOfferStatus } from '../trip-requests/entities/driver-offer.entity';
import { CacheService } from '../common/services/cache.service';
import { WalletService } from '../wallet/wallet.service';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { lockTripBookingCreation } from '../bookings/bookable-trip-transaction';
import { retireRequestInvitations, RETIRE_COUNTEROFFER_NOTIFICATIONS_SQL } from '../trip-requests/dispatch/retire-request-invitations';
import { enqueueTransactionalNotification } from '../notifications/transactional-notification';

export function assertNoUnfinishedBoarding(bookings: Booking[]) {
  if (bookings.some(b => b.status === BookingStatus.BOARDING_UNCERTAIN ||
      ([BookingStatus.PENDING, BookingStatus.ACCEPTED].includes(b.status) &&
        (b.pickedUp || b.pickedUpAt || b.pickedUpConfirmedByPassenger || b.pickedUpConfirmedAt ||
          b.rideDeclarations?.pickup?.driver?.decision === 'confirm' ||
          b.rideDeclarations?.pickup?.passenger?.decision === 'confirm'))))
    throw new ConflictException({ code: 'ACCOUNT_HAS_UNFINISHED_RIDE',
      message: 'Un trajet avec passager à bord doit être clôturé avant de désactiver ou supprimer ce compte.' });
}

@Injectable()
export class AccountLifecycleService {
  constructor(private readonly db: DataSource, private readonly wallet: WalletService,
    private readonly cache: CacheService) {}

  /** Logical retirement only. Financial records and completed journeys are never deleted.
   * All business changes and outbox events commit together, with no network I/O. */
  async deactivate(userId: string, status: UserStatus.SUSPENDED | UserStatus.INACTIVE,
    profileChange?: (manager: EntityManager) => Promise<void>): Promise<User> {
    const keys = new Set<string>([CacheService.getVehiclesByOwnerKey(userId),
      CacheService.getTripsListKey(), CacheService.getTripsListKey('all'), CacheService.getTripsListKey('allTrips')]);
    const result = await this.db.transaction(async manager => {
      // Serialize state changes without blocking foreign-key checks by the
      // other participant's outbox/booking transaction.
      const user = await manager.findOne(User, { where: { id: userId }, lock: { mode: 'for_no_key_update' } });
      if (!user) throw new NotFoundException('Utilisateur introuvable');

      // Requests precede booking/trip locks, as in request acceptance/reassignment.
      const requests = await manager.getRepository(TripRequest).createQueryBuilder('r')
        .where(`(r."passengerId" = :userId OR r."selectedDriverId"::text = :userId::text
          OR r."targetDriverId" = :userId OR EXISTS (SELECT 1 FROM driver_offers o
            WHERE o."tripRequestId"=r.id AND o."driverId"=:userId AND o.status='pending')
          OR EXISTS (SELECT 1 FROM trip_request_dispatch_offers d
            WHERE d."requestId"=r.id AND d."driverId"=:userId AND d.status='pending'))`, { userId })
        .andWhere("r.status IN ('pending', 'offers_received', 'driver_selected')")
        .orderBy('r.id', 'ASC').setLock('pessimistic_write').getMany();
      const tripRows: { id: string }[] = await manager.query(`SELECT t.id FROM trips t
        WHERE (t."driverId"=$1 AND t.status IN ('upcoming','ongoing')) OR EXISTS (
          SELECT 1 FROM bookings b WHERE b."tripId"=t.id AND (b."passengerId"=$1 OR t."driverId"=$1)
            AND b.status IN ('pending','accepted','boarding_uncertain'))
        ORDER BY t.id`, [userId]);
      for (const { id } of tripRows) await lockTripBookingCreation(manager, id);
      // Keep the existing booking -> trip row-lock order used by payment/boarding.
      const bookings = await manager.getRepository(Booking).createQueryBuilder('b')
        .addSelect('b.rideDeclarations')
        .where(`(b."passengerId"=:userId OR b."tripId" IN (SELECT id FROM trips WHERE "driverId"=:userId))`, { userId })
        .andWhere('b.status IN (:...statuses)', { statuses: [BookingStatus.PENDING, BookingStatus.ACCEPTED, BookingStatus.BOARDING_UNCERTAIN] })
        .orderBy('b.id', 'ASC').setLock('pessimistic_write').getMany();
      assertNoUnfinishedBoarding(bookings);
      const trips = tripRows.length ? await manager.getRepository(Trip).createQueryBuilder('t')
        .where('t.id IN (:...ids)', { ids: tripRows.map(t => t.id) })
        .orderBy('t.id', 'ASC').setLock('pessimistic_write').getMany() : [];
      const tripMap = new Map(trips.map(t => [t.id, t]));

      for (const booking of bookings) {
        const trip = tripMap.get(booking.tripId)!;
        // A completed trip with an unclosed booking needs support, not silent erasure.
        if (trip.status === TripStatus.COMPLETED)
          throw new ConflictException({ code: 'ACCOUNT_HAS_UNFINISHED_RIDE', message: 'Clôturez les réservations du trajet terminé avant de désactiver ce compte.' });
        if (booking.paymentMode === TripPaymentMode.POINTS && booking.paymentStatus === BookingPaymentStatus.SUCCEEDED) {
          await this.wallet.refundBookingPayment(booking, manager);
          booking.paymentStatus = BookingPaymentStatus.CANCELLED;
          booking.paidAt = null;
        }
        booking.status = BookingStatus.CANCELLED;
        booking.cancelledAt = new Date();
        // Do not rewrite a real electronic receipt or presume a provider refund.
        if (booking.paymentStatus !== BookingPaymentStatus.SUCCEEDED) {
          booking.firstTripSubsidyApplied = false;
          booking.zwangaSubsidyAmount = 0;
          booking.passengerPaymentRate = 1;
        }
        await manager.save(Booking, booking);
        keys.add(CacheService.getBookingKey(booking.id));
        keys.add(CacheService.getBookingsByPassengerKey(booking.passengerId));
        keys.add(CacheService.getBookingsByTripKey(trip.id));
        await manager.query(`UPDATE notifications SET "isActive"=false WHERE "isActive"=true
          AND data->>'bookingId'=$1::text AND data->>'type' IN ('new_booking','booking_response')`, [booking.id]);
        const recipient = booking.passengerId === userId ? trip.driverId : booking.passengerId;
        if (recipient !== userId) await enqueueTransactionalNotification(manager, {
          eventKey: `account-disabled:${userId}:booking:${booking.id}`, userId: recipient,
          title: 'Réservation annulée', body: 'La réservation a été annulée car le compte de l’autre participant n’est plus disponible.',
          data: { type: 'booking_cancelled', bookingId: booking.id, tripId: trip.id, status: 'cancelled' },
        });
      }
      for (const trip of trips) {
        if (![TripStatus.PENDING, TripStatus.ACTIVE].includes(trip.status)) continue;
        const remaining = await manager.getRepository(Booking).find({ where: { tripId: trip.id,
          status: In([BookingStatus.PENDING, BookingStatus.ACCEPTED, BookingStatus.BOARDING_UNCERTAIN]) } });
        if (trip.driverId === userId || (trip.isPrivate && !remaining.length)) trip.status = TripStatus.CANCELLED;
        const occupied = remaining.filter(b => b.status !== BookingStatus.PENDING).reduce((sum, b) => sum + b.numberOfSeats, 0);
        if (trip.totalSeats != null) trip.availableSeats = Math.max(0, trip.totalSeats - occupied);
        await manager.update(Trip, trip.id, { status: trip.status, availableSeats: trip.availableSeats });
        keys.add(CacheService.getTripKey(trip.id));
      }
      for (const request of requests) {
        const owned = request.passengerId === userId || request.selectedDriverId === userId;
        const linked = request.tripId ? tripMap.get(request.tripId) ?? await manager.findOneBy(Trip, { id: request.tripId }) : undefined;
        if (owned && [TripRequestStatus.PENDING, TripRequestStatus.OFFERS_RECEIVED, TripRequestStatus.DRIVER_SELECTED].includes(request.status)
            && linked?.status !== TripStatus.COMPLETED) {
          await manager.update(TripRequest, request.id, { id: request.id, status: TripRequestStatus.CANCELLED,
            targetDriverPriorityUntil: null });
          await retireRequestInvitations(manager, request.id, true);
          await manager.update(DriverOffer, { tripRequestId: request.id, status: DriverOfferStatus.ACCEPTED },
            { status: DriverOfferStatus.CANCELLED });
          if (request.passengerId !== userId) await enqueueTransactionalNotification(manager, {
            eventKey: `account-disabled:${userId}:request:${request.id}`, userId: request.passengerId,
            title: 'Demande annulée', body: 'Le conducteur n’est plus disponible. Vous pouvez créer une nouvelle demande.',
            data: { type: 'trip_request_cancelled', tripRequestId: request.id },
          });
        } else {
          const offers = await manager.find(DriverOffer, { where: { tripRequestId: request.id, driverId: userId, status: DriverOfferStatus.PENDING } });
          if (offers.length) {
            await manager.update(DriverOffer, { id: In(offers.map(o => o.id)) }, { status: DriverOfferStatus.CANCELLED });
            await manager.query(RETIRE_COUNTEROFFER_NOTIFICATIONS_SQL, [request.id, offers.map(o => o.id)]);
          }
          await manager.query(`UPDATE trip_request_dispatch_offers SET status='cancelled'
            WHERE "requestId"=$1 AND "driverId"=$2 AND status='pending'`, [request.id, userId]);
          // Clear both fields: a target without a deadline hides the request
          // forever from others. Never reopen an already assigned/closed ride.
          if (request.targetDriverId === userId && !request.selectedDriverId && !request.tripId &&
              [TripRequestStatus.PENDING, TripRequestStatus.OFFERS_RECEIVED].includes(request.status)) {
            await manager.update(TripRequest, request.id, {
              targetDriverId: null, targetDriverPriorityUntil: null, dispatchCheckedAt: null,
            });
          }
        }
      }
      const vehicles = await manager.find(Vehicle, { where: { ownerId: userId }, select: ['id'] });
      for (const vehicle of vehicles) keys.add(CacheService.getVehicleKey(vehicle.id));
      await manager.update(Vehicle, { ownerId: userId }, { isActive: false });
      await manager.update(RecurringTripTemplate, { driverId: userId }, { status: RecurringTripTemplateStatus.PAUSED });
      await manager.query(`UPDATE driver_dispatch_presence SET "discoveryEnabled"=false WHERE "driverId"=$1`, [userId]);
      await manager.query(`UPDATE notifications SET "isActive"=false WHERE "userId"=$1 AND "isActive"=true`, [userId]);
      await manager.update(User, userId, { status, isActive: false, accessToken: null, refreshToken: null, fcmToken: null });
      await profileChange?.(manager);
      return (await manager.findOneBy(User, { id: userId }))!;
    });
    // Best-effort read cache; authorization/visibility always recheck the owner.
    for (const key of keys) await this.cache.del(key).catch(() => undefined);
    return result;
  }
}
