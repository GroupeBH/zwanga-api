import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking } from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { enqueueTransactionalNotification } from '../notifications/transactional-notification';
import { hasRideDispute } from '../ride-declarations/ride-declaration.model';
import { isNearDestination } from './near-arrival-payment';

export function canRequestBookingPayment(booking: Booking, now = Date.now()): boolean {
  if (!['electronic', 'points'].includes(booking.paymentMode) ||
      ['succeeded', 'initiated'].includes(booking.paymentStatus) || !(Number(booking.paymentAmount) > 0) ||
      hasRideDispute(booking.rideDeclarations) || booking.interruptionFareLocked) return false;
  if (booking.status === 'completed' && booking.droppedOff) return true;
  return booking.status === 'accepted' && booking.trip?.status === 'ongoing' &&
    Boolean(booking.pickedUp || booking.pickedUpAt) && !booking.droppedOff &&
    isNearDestination(booking.trip.currentLocation, booking.trip.lastLocationUpdateAt,
      booking.passengerDestinationPoint ?? booking.trip.arrivalPoint, now, 500);
}

@Injectable()
export class PaymentRequestService {
  constructor(@InjectRepository(Booking) private readonly repository: Repository<Booking>) {}

  async read(id: string, userId: string) {
    const booking = await this.repository.findOne({ where: { id }, relations: ['trip'] });
    if (!booking) throw new NotFoundException('Réservation non trouvée.');
    if (booking.passengerId !== userId && booking.trip?.driverId !== userId) throw new ForbiddenException();
    const notification = await this.repository.manager.findOne(Notification, {
      where: { eventKey: `booking-payment-request:${id}:${booking.paymentMode}`, userId: booking.passengerId },
    });
    return { bookingId: id, requestedAt: notification?.createdAt ?? null };
  }

  async request(id: string, driverId: string) {
    await this.repository.manager.transaction(async manager => {
      const booking = await manager.createQueryBuilder(Booking, 'booking')
        .addSelect('booking.rideDeclarations').where('booking.id = :id', { id }).setLock('pessimistic_write').getOne();
      if (!booking) throw new NotFoundException('Réservation non trouvée.');
      // Informational invitation only. Do not wait on a trip lock while holding a
      // booking: legacy arrival declarations acquire those locks in reverse order.
      const trip = await manager.findOne(Trip, { where: { id: booking.tripId } });
      if (!trip || trip.driverId !== driverId) throw new ForbiddenException('Seul le conducteur de ce trajet peut demander le paiement.');
      booking.trip = trip;
      if (!canRequestBookingPayment(booking)) throw new BadRequestException('Paiement indisponible. Actualisez le trajet et votre position. Le passager doit être à bord et à moins de 500 m de son arrivée, ou déjà arrivé.');
      // An invitation only: no wallet debit, payment-provider call or fare update.
      // Unique event key makes retries/double taps harmless, including across devices.
      await enqueueTransactionalNotification(manager, {
        eventKey: `booking-payment-request:${id}:${booking.paymentMode}`, userId: booking.passengerId,
        title: 'Votre arrivée approche', body: 'Votre conducteur vous invite à régler le trajet. Vérifiez et confirmez le paiement dans Zwanga.',
        data: { type: 'booking_payment_requested', bookingId: id, tripId: trip.id, role: 'passenger' },
      });
    });
    return this.read(id, driverId);
  }
}
