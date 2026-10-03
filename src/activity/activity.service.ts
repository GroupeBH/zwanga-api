import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { TripRequest } from '../trip-requests/entities/trip-request.entity';
import { activeBookingWhere, activeTripWhere } from '../common/activity-read-policy';
import { AccountActivity, ActivityRow, activityRevision, trackingBookingId } from './activity.model';

const columns = (alias: string, names: string) => names.split(' ').map(name => `${alias}.${name}`);

@Injectable()
export class ActivityService {
  constructor(
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(TripRequest) private readonly requests: Repository<TripRequest>,
  ) {}

  async read(userId: string): Promise<AccountActivity> {
    const now = Date.now();
    // No SELECT *, history hydration, ratings, route previews, or external services.
    // GPS coordinates/timestamps are intentionally not revision inputs. Ride state is.
    const [trips, bookings, requests] = await Promise.all([
      this.readTrips(userId, now), this.readBookings(userId, now), this.readRequests(userId, now),
    ]);
    return {
      schemaVersion: 1, userId,
      trips: activityRevision(trips), bookings: activityRevision(bookings), requests: activityRevision(requests),
      hasLiveActivity: trips.some(row => row.status === 'ongoing')
        || bookings.some(row => row.tripStatus === 'ongoing' || row.paymentStatus === 'initiated'),
      passengerTrackingBookingId: trackingBookingId(bookings, now),
    };
  }

  private readTrips(userId: string, now: number): Promise<ActivityRow[]> {
    return this.trips.createQueryBuilder('trip')
      .setFindOptions({ where: activeTripWhere(userId, now) })
      .select(columns('trip', 'driverId vehicleId departureDate departureLocation arrivalLocation departureReference arrivalReference departurePoint arrivalPoint totalSeats availableSeats pricePerSeat isFree requiresPassengerKyc startedAt completedAt'))
      .addSelect('trip.id', 'id').addSelect('trip.status', 'status')
      .leftJoin('trip.bookings', 'booking')
      .addSelect(columns('booking', 'cashReceivedAt cashReceivedByDriverId cashReceivedAmount droppedOffAt interruptionFareLocked'))
      .addSelect(columns('booking', 'id passengerId status numberOfSeats pickedUp droppedOff droppedOffConfirmedByPassenger paymentStatus paymentMode paymentAmount paymentCurrency paidAt'))
      .leftJoin('booking.interruptionRequests', 'passengerInterruption')
      .addSelect(columns('passengerInterruption', 'id updatedAt'))
      .leftJoin('trip.driverInterruptionRequests', 'driverInterruption')
      .addSelect(columns('driverInterruption', 'id updatedAt'))
      .getRawMany<ActivityRow>();
  }

  private readBookings(userId: string, now: number): Promise<ActivityRow[]> {
    return this.bookings.createQueryBuilder('booking')
      .setFindOptions({ where: activeBookingWhere(userId, now) })
      .select(columns('booking', 'tripId passengerId numberOfSeats pickedUp pickedUpAt pickedUpConfirmedByPassenger droppedOffAt droppedOffConfirmedAt paymentAmount grossPaymentAmount originalPaymentAmount firstTripSubsidyApplied passengerPaymentRate zwangaSubsidyAmount paymentCurrency paymentMode paymentReference paymentTransactionId paidAt interruptionFareLocked fareAdjustmentAmount fareAdjustedAt plannedDistanceMeters travelledDistanceMeters passengerOrigin passengerDestination passengerOriginReference passengerDestinationReference passengerOriginPoint passengerDestinationPoint passengerDestinationApproachNotifiedAt'))
      .addSelect('booking.id', 'id').addSelect('booking.status', 'status')
      .addSelect(columns('booking', 'cashReceivedAt cashReceivedByDriverId cashReceivedAmount'))
      .addSelect('booking.paymentStatus', 'paymentStatus')
      .addSelect('booking.droppedOff', 'droppedOff')
      .addSelect('booking.droppedOffConfirmedByPassenger', 'droppedOffConfirmedByPassenger')
      .leftJoin('booking.trip', 'trip')
      .addSelect('trip.status', 'tripStatus').addSelect('trip.departureDate', 'departureDate')
      .addSelect(columns('trip', 'id driverId vehicleId arrivalLocation arrivalReference arrivalPoint departureLocation departureReference departurePoint pricePerSeat isFree completedAt'))
      .leftJoin('booking.interruptionRequests', 'passengerInterruption')
      .addSelect(columns('passengerInterruption', 'id updatedAt'))
      .leftJoin('booking.tripInterruptionConfirmations', 'confirmation')
      .addSelect(columns('confirmation', 'id updatedAt'))
      .leftJoin('trip.driverInterruptionRequests', 'driverInterruption')
      .addSelect(columns('driverInterruption', 'id updatedAt'))
      .getRawMany<ActivityRow>();
  }

  private readRequests(userId: string, now: number): Promise<ActivityRow[]> {
    return this.requests.createQueryBuilder('request')
      .select(columns('request', 'status updatedAt departureDateMax selectedDriverId driverPickupOverdueNotifiedAt'))
      .addSelect('request.id', 'id')
      .leftJoin('request.driverOffers', 'offer').addSelect(columns('offer', 'id updatedAt'))
      .where('request.passengerId = :userId', { userId })
      .andWhere('(request.status IN (:...statuses) OR request.updatedAt >= :recent)', {
        statuses: ['pending', 'offers_received', 'driver_selected'], recent: new Date(now - 48 * 60 * 60_000),
      })
      .getRawMany<ActivityRow>();
  }
}
