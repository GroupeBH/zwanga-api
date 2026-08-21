import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EntityManager, Repository, In, Raw, Equal, IsNull } from 'typeorm';
import type { Point } from 'typeorm';
import {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from './entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import {
  DriverTripInterruptionRequest,
  PassengerTripInterruptionRequest,
  TripInterruptionReason,
  TripInterruptionStatus,
} from '../trips/entities/trip-interruption.entity';
import { RequestTripInterruptionDto } from '../trips/dto/trip-interruption.dto';
import { User } from '../users/entities/user.entity';
import {
  CreateBookingDto,
  ConfirmDropoffDto,
  UpdateBookingStatusDto,
  ReportBookingProblemDto,
  UpdatePassengerLocationDto,
} from './dto/booking.dto';
import {
  FlexPayCallbackDto,
  InitiatePaymentDto,
} from '../payments/dto/payment.dto';
import {
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { PaymentsService } from '../payments/payments.service';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { WalletService } from '../wallet/wallet.service';
import { DriverSettlementsService } from '../driver-settlements/driver-settlements.service';
import { CacheService } from '../common/services/cache.service';
import {
  LocationHistoryService,
  type LocationHistorySnapshot,
  type TrackedLocationPoint,
} from '../common/services/location-history.service';
import {
  BoardingDetectionState,
  BoardingRejectionReason,
  evaluateBoardingDetection,
  type BoardingDetectionMetrics,
  type BoardingLocationSample,
} from './boarding-detection';
import {
  loadBoardingDetectionConfig,
  type BoardingDetectionConfig,
} from './boarding-detection.config';
import { NotificationService } from '../notifications/notifications.service';
import { FileUploadService } from '../common/services/file-upload.service';
import { MessagingService } from '../messaging/messaging.service';
import { SafetyService } from '../safety/safety.service';
import { SendWhatsAppNotificationDto } from './dto/send-whatsapp-notification.dto';
import { GoogleMapsService } from '../google-maps/google-maps.service';
import { TravelMode } from '../google-maps/dto/google-maps.dto';
import {
  buildPointFromCoordinate,
  isCoordinateAllowedForTrip,
  isFreshLocationTimestamp,
  LIVE_LOCATION_FRESHNESS_MS,
  normalizeLocationRecordedAt,
  normalizeCoordinateForTrip,
  normalizeLatLngCoordinate,
  pointToCoordinate,
} from '../common/utils/tracking-coordinates';

export interface BookingPaymentResponse {
  booking: Booking;
  payment: {
    transactionId: string | null;
    method: PaymentTransaction['method'] | null;
    reference: string | null;
    orderNumber: string | null;
    status: PaymentStatus | null;
    statusCode: string | null;
    message: string | null;
    paymentUrl: string | null;
    amount: number;
    currency: string;
  };
}

export interface BookingFlexPayCallbackResponse {
  received: boolean;
  verified: boolean;
  bookingId: string;
  bookingPaymentStatus: BookingPaymentStatus;
  paymentTransactionId: string | null;
  paymentStatus: PaymentStatus | null;
  paymentStatusCode: string | null;
  message: string | null;
}

export interface AutomaticRideProgressEvent {
  type:
    | 'driver_near_pickup'
    | 'driver_arrived_pickup'
    | 'parties_nearby'
    | 'passenger_ready_pickup'
    | 'pickup_confirmed'
    | 'passenger_no_show'
    | 'passenger_boarding_uncertain'
    | 'passenger_near_destination'
    | 'dropoff_confirmed'
    | 'driver_near_destination'
    | 'driver_arrived_destination';
  bookingId?: string;
  tripId: string;
  passengerId?: string;
  distanceMeters?: number;
  detectedAt?: string;
  expiresAt?: string;
  pickupWaitSeconds?: number;
  boardingState?: BoardingDetectionState;
  confidenceScore?: number;
  decision?: 'CONFIRM' | 'OBSERVE' | 'REJECT';
  rejectionReason?: BoardingRejectionReason | null;
  noShowReason?: string;
  boardingUncertainReason?: string;
  detectionMethod?: string;
}

export interface AutomaticRideProgressResult {
  tripId: string;
  events: AutomaticRideProgressEvent[];
}

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);
  private readonly CACHE_TTL = 180; // 3 minutes
  private readonly DESTINATION_PROXIMITY_THRESHOLD_METERS = 1000; // 1 km
  private readonly AUTO_PROGRESS_LOCATION_FRESHNESS_MS =
    LIVE_LOCATION_FRESHNESS_MS;
  private readonly AUTO_PICKUP_MATCH_THRESHOLD_METERS = 25;
  private readonly AUTO_PICKUP_PASSENGER_READY_THRESHOLD_METERS = 5;
  private readonly AUTO_PICKUP_DRIVER_NEAR_THRESHOLD_METERS = 200;
  private readonly AUTO_PICKUP_DRIVER_ARRIVAL_THRESHOLD_METERS = 80;
  private readonly AUTO_PICKUP_MOVEMENT_THRESHOLD_METERS = 30;
  private readonly AUTO_PICKUP_MAX_HEADING_DELTA_DEGREES = 60;
  private readonly PICKUP_WAIT_WINDOW_MS = 10 * 60 * 1000;
  private readonly AUTO_NO_SHOW_DRIVER_DEPARTURE_THRESHOLD_METERS = 150;
  private readonly PASSENGER_DESTINATION_NOTICE_THRESHOLD_METERS = 40;
  private readonly AUTO_DROPOFF_DIRECT_CONFIRM_THRESHOLD_METERS = 25;
  private readonly AUTO_DROPOFF_DRIVER_EXIT_THRESHOLD_METERS = 40;
  private readonly AUTO_DROPOFF_PASSENGER_STAY_THRESHOLD_METERS = 40;
  private readonly AUTO_DROPOFF_DRIVER_PASSENGER_SEPARATION_THRESHOLD_METERS = 60;
  private readonly AUTO_TRIP_DESTINATION_NOTICE_THRESHOLD_METERS = 25;
  private readonly AUTO_TRIP_DESTINATION_REACHED_THRESHOLD_METERS = 25;
  private readonly AUTO_TRIP_DESTINATION_PASSED_GRACE_METERS = 0;
  private readonly AUTO_TRIP_DESTINATION_COMPLETION_DELAY_MS = 10 * 60 * 1000;
  private readonly MAX_SEATS_PER_PASSENGER = 2;
  private readonly BOOKING_RELATED_ENTITY_TYPE = 'booking';
  private readonly DEFAULT_TRIP_PAYMENT_CURRENCY = 'CDF';
  private readonly boardingDetectionConfig: BoardingDetectionConfig;
  private readonly automaticRideProgressQueues = new Map<
    string,
    Promise<void>
  >();

  constructor(
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(Trip)
    private tripRepository: Repository<Trip>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(PassengerTripInterruptionRequest)
    private passengerTripInterruptionRepository: Repository<PassengerTripInterruptionRequest>,
    @InjectRepository(DriverTripInterruptionRequest)
    private driverTripInterruptionRepository: Repository<DriverTripInterruptionRequest>,
    private cacheService: CacheService,
    private notificationService: NotificationService,
    private fileUploadService: FileUploadService,
    private messagingService: MessagingService,
    private safetyService: SafetyService,
    private googleMapsService: GoogleMapsService,
    private configService: ConfigService,
    private paymentsService: PaymentsService,
    private walletService: WalletService,
    private driverSettlementsService: DriverSettlementsService,
    private locationHistoryService: LocationHistoryService,
  ) {
    this.boardingDetectionConfig = loadBoardingDetectionConfig(
      this.configService,
    );
  }

  private buildPointFromLatLng(
    latitude: number,
    longitude: number,
  ): Point | null {
    const coordinate = normalizeLatLngCoordinate(latitude, longitude);
    return buildPointFromCoordinate(coordinate);
  }

  private buildTripScopedPointFromLatLng(
    latitude: number,
    longitude: number,
    trip: Trip,
    context: string,
  ): Point {
    const coordinate = normalizeCoordinateForTrip(latitude, longitude, trip);
    if (!coordinate) {
      throw new BadRequestException(
        `Coordonnees ${context} invalides ou incoherentes avec le trajet`,
      );
    }

    return buildPointFromCoordinate(coordinate)!;
  }

  private pointToLatLng(
    point?: Point | null,
  ): { latitude: number; longitude: number } | null {
    return pointToCoordinate(point);
  }

  private sanitizePointForTrip(
    point: Point | null | undefined,
    trip: Trip,
  ): Point | null {
    const coordinate = this.pointToLatLng(point);
    if (!coordinate || !isCoordinateAllowedForTrip(coordinate, trip)) {
      return null;
    }

    return buildPointFromCoordinate(coordinate);
  }

  private calculatePointDistanceMeters(
    first?: Point | null,
    second?: Point | null,
  ): number | null {
    const a = this.pointToLatLng(first);
    const b = this.pointToLatLng(second);
    if (!a || !b) {
      return null;
    }

    const earthRadiusMeters = 6371000;
    const toRadians = (value: number) => (value * Math.PI) / 180;
    const deltaLatitude = toRadians(b.latitude - a.latitude);
    const deltaLongitude = toRadians(b.longitude - a.longitude);
    const latitudeA = toRadians(a.latitude);
    const latitudeB = toRadians(b.latitude);

    const haversine =
      Math.sin(deltaLatitude / 2) * Math.sin(deltaLatitude / 2) +
      Math.cos(latitudeA) *
        Math.cos(latitudeB) *
        Math.sin(deltaLongitude / 2) *
        Math.sin(deltaLongitude / 2);

    return (
      earthRadiusMeters *
      2 *
      Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
    );
  }

  private normalizeHeadingDelta(left: number, right: number): number {
    const delta = Math.abs(((left - right + 540) % 360) - 180);
    return Number.isFinite(delta) ? delta : 180;
  }

  private calculatePointBearingDegrees(
    from?: Point | null,
    to?: Point | null,
  ): number | null {
    const start = this.pointToLatLng(from);
    const end = this.pointToLatLng(to);
    if (!start || !end) {
      return null;
    }

    const startLatitude = (start.latitude * Math.PI) / 180;
    const endLatitude = (end.latitude * Math.PI) / 180;
    const longitudeDelta = ((end.longitude - start.longitude) * Math.PI) / 180;
    const y = Math.sin(longitudeDelta) * Math.cos(endLatitude);
    const x =
      Math.cos(startLatitude) * Math.sin(endLatitude) -
      Math.sin(startLatitude) *
        Math.cos(endLatitude) *
        Math.cos(longitudeDelta);

    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  private buildPointFromTrackedLocation(
    location?: TrackedLocationPoint | null,
  ): Point | null {
    if (!location) {
      return null;
    }

    return this.buildPointFromLatLng(location.latitude, location.longitude);
  }

  private getBoardingLocationSamples(
    history: LocationHistorySnapshot | null,
  ): BoardingLocationSample[] {
    const samples = history?.samples?.length
      ? history.samples
      : [history?.previous, history?.current].filter(
          (sample): sample is TrackedLocationPoint => Boolean(sample),
        );

    return samples.map((sample) => ({
      latitude: sample.latitude,
      longitude: sample.longitude,
      recordedAt: sample.recordedAt,
      accuracyMeters:
        typeof sample.accuracyMeters === 'number'
          ? sample.accuracyMeters
          : null,
      speedMetersPerSecond:
        typeof sample.speedMetersPerSecond === 'number'
          ? sample.speedMetersPerSecond
          : null,
      headingDegrees:
        typeof sample.headingDegrees === 'number'
          ? sample.headingDegrees
          : null,
    }));
  }

  private logBoardingDetectionEvaluation(
    booking: Booking,
    metrics: BoardingDetectionMetrics,
  ): void {
    this.logger.log(
      JSON.stringify({
        event: 'boarding_detection_evaluation',
        tripId: booking.tripId,
        driverId: booking.trip?.driverId ?? null,
        passengerId: booking.passengerId,
        ...metrics,
      }),
    );
  }

  private isFreshTrackedLocation(
    location: TrackedLocationPoint | null | undefined,
    now = new Date(),
  ): boolean {
    if (!location?.recordedAt) {
      return false;
    }

    return this.isFreshLocationUpdate(location.recordedAt, now);
  }

  private hasFreshLocationHistoryPair(
    driverHistory: LocationHistorySnapshot | null,
    passengerHistory: LocationHistorySnapshot | null,
    now = new Date(),
  ): boolean {
    return (
      this.isFreshTrackedLocation(driverHistory?.previous, now) &&
      this.isFreshTrackedLocation(driverHistory?.current, now) &&
      this.isFreshTrackedLocation(passengerHistory?.previous, now) &&
      this.isFreshTrackedLocation(passengerHistory?.current, now)
    );
  }

  private areDriverAndPassengerMovingTogetherFromHistory(
    driverHistory: LocationHistorySnapshot | null,
    passengerHistory: LocationHistorySnapshot | null,
    now = new Date(),
  ): boolean {
    if (
      !this.hasFreshLocationHistoryPair(driverHistory, passengerHistory, now)
    ) {
      return false;
    }

    const driverPrevious = this.buildPointFromTrackedLocation(
      driverHistory?.previous,
    );
    const driverCurrent = this.buildPointFromTrackedLocation(
      driverHistory?.current,
    );
    const passengerPrevious = this.buildPointFromTrackedLocation(
      passengerHistory?.previous,
    );
    const passengerCurrent = this.buildPointFromTrackedLocation(
      passengerHistory?.current,
    );
    const driverMovement = this.calculatePointDistanceMeters(
      driverPrevious,
      driverCurrent,
    );
    const passengerMovement = this.calculatePointDistanceMeters(
      passengerPrevious,
      passengerCurrent,
    );
    const currentPhoneDistance = this.calculatePointDistanceMeters(
      driverCurrent,
      passengerCurrent,
    );
    if (
      driverMovement === null ||
      passengerMovement === null ||
      currentPhoneDistance === null ||
      driverMovement < this.AUTO_PICKUP_MOVEMENT_THRESHOLD_METERS ||
      passengerMovement < this.AUTO_PICKUP_MOVEMENT_THRESHOLD_METERS ||
      currentPhoneDistance > this.AUTO_PICKUP_MATCH_THRESHOLD_METERS
    ) {
      return false;
    }

    const driverBearing = this.calculatePointBearingDegrees(
      driverPrevious,
      driverCurrent,
    );
    const passengerBearing = this.calculatePointBearingDegrees(
      passengerPrevious,
      passengerCurrent,
    );
    if (driverBearing === null || passengerBearing === null) {
      return false;
    }

    return (
      this.normalizeHeadingDelta(driverBearing, passengerBearing) <=
      this.AUTO_PICKUP_MAX_HEADING_DELTA_DEGREES
    );
  }

  private hasDriverContinuedAfterDropoffFromHistory(
    driverHistory: LocationHistorySnapshot | null,
    dropoffPoint: Point | null,
    now = new Date(),
  ): boolean {
    if (
      !this.isFreshTrackedLocation(driverHistory?.previous, now) ||
      !this.isFreshTrackedLocation(driverHistory?.current, now)
    ) {
      return false;
    }

    const previousDistance = this.calculatePointDistanceMeters(
      this.buildPointFromTrackedLocation(driverHistory?.previous),
      dropoffPoint,
    );
    const currentDistance = this.calculatePointDistanceMeters(
      this.buildPointFromTrackedLocation(driverHistory?.current),
      dropoffPoint,
    );
    if (previousDistance === null || currentDistance === null) {
      return false;
    }

    return (
      previousDistance <= this.PASSENGER_DESTINATION_NOTICE_THRESHOLD_METERS &&
      currentDistance >= this.AUTO_DROPOFF_DRIVER_EXIT_THRESHOLD_METERS &&
      currentDistance > previousDistance
    );
  }

  private calculateAvailableSeatsFromAcceptedBookings(
    trip: Pick<Trip, 'totalSeats' | 'availableSeats'>,
    bookings: Array<Pick<Booking, 'status' | 'numberOfSeats'>>,
  ): number {
    if (trip.totalSeats === null || trip.totalSeats === undefined) {
      return Math.max(0, trip.availableSeats ?? 0);
    }

    const acceptedSeats = bookings
      .filter((booking) => booking.status === BookingStatus.ACCEPTED)
      .reduce((sum, booking) => sum + Number(booking.numberOfSeats ?? 0), 0);

    return Math.max(0, trip.totalSeats - acceptedSeats);
  }

  private async getAcceptedSeatCount(
    tripId: string,
    manager?: EntityManager,
    excludedBookingId?: string,
  ): Promise<number> {
    const repository = manager
      ? manager.getRepository(Booking)
      : this.bookingRepository;
    const query = repository
      .createQueryBuilder('booking')
      .select('COALESCE(SUM(booking.numberOfSeats), 0)', 'seats')
      .where('booking.tripId = :tripId', { tripId })
      .andWhere('booking.status = :status', {
        status: BookingStatus.ACCEPTED,
      });

    if (excludedBookingId) {
      query.andWhere('booking.id != :excludedBookingId', {
        excludedBookingId,
      });
    }

    const result = await query.getRawOne<{ seats: string | number | null }>();
    return Number(result?.seats ?? 0);
  }

  private async recalculateAvailableSeatsForTrip(
    tripId: string,
    manager?: EntityManager,
  ): Promise<number> {
    const tripRepository = manager
      ? manager.getRepository(Trip)
      : this.tripRepository;
    const trip = await tripRepository.findOne({ where: { id: tripId } });

    if (!trip) {
      throw new NotFoundException('Trajet non trouve');
    }

    if (trip.totalSeats === null || trip.totalSeats === undefined) {
      return trip.availableSeats;
    }

    const acceptedSeats = await this.getAcceptedSeatCount(tripId, manager);
    const availableSeats = Math.max(0, trip.totalSeats - acceptedSeats);

    if (trip.availableSeats !== availableSeats) {
      trip.availableSeats = availableSeats;
      await tripRepository.save(trip);
    }

    return availableSeats;
  }

  private async updateStatusTransactionally(
    bookingId: string,
    driverId: string,
    updateStatusDto: UpdateBookingStatusDto,
  ): Promise<Booking> {
    const entityManager = this.bookingRepository.manager;
    const updatedBooking = await entityManager.transaction(async (manager) => {
      const bookingRepository = manager.getRepository(Booking);
      const tripRepository = manager.getRepository(Trip);
      const booking = await bookingRepository.findOne({
        where: { id: bookingId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!booking) {
        this.logger.warn(
          `Booking status update failed: Booking ${bookingId} not found`,
        );
        throw new NotFoundException('Reservation non trouvee');
      }

      const trip = await tripRepository.findOne({
        where: { id: booking.tripId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!trip) {
        throw new NotFoundException('Trajet non trouve');
      }

      if (trip.driverId !== driverId) {
        this.logger.warn(
          `Booking status update failed: Driver ${driverId} tried to update booking ${bookingId} (owner: ${trip.driverId})`,
        );
        throw new BadRequestException(
          'Seul le conducteur du trajet peut modifier le statut de la reservation',
        );
      }

      const oldStatus = booking.status;
      const nextStatus = updateStatusDto.status;

      if (oldStatus === nextStatus) {
        return booking;
      }

      if (
        [
          BookingStatus.CANCELLED,
          BookingStatus.REJECTED,
          BookingStatus.NO_SHOW,
          BookingStatus.BOARDING_UNCERTAIN,
          BookingStatus.EXPIRED,
        ].includes(oldStatus)
      ) {
        throw new BadRequestException(
          `Impossible de modifier une reservation ${oldStatus}`,
        );
      }

      switch (nextStatus) {
        case BookingStatus.ACCEPTED: {
          if (oldStatus !== BookingStatus.PENDING) {
            throw new BadRequestException(
              'Seule une reservation en attente peut etre acceptee',
            );
          }
          if (![TripStatus.PENDING, TripStatus.ACTIVE].includes(trip.status)) {
            throw new BadRequestException(
              "Ce trajet n'est plus disponible pour accepter une reservation",
            );
          }
          if (trip.totalSeats === null || trip.totalSeats === undefined) {
            throw new BadRequestException(
              "Ce trajet n'a pas de nombre de places defini",
            );
          }

          const acceptedSeats = await this.getAcceptedSeatCount(
            trip.id,
            manager,
            booking.id,
          );
          const seatsAfterAcceptance = acceptedSeats + booking.numberOfSeats;

          if (seatsAfterAcceptance > trip.totalSeats) {
            throw new BadRequestException(
              `Pas assez de places disponibles. Disponibles : ${Math.max(
                0,
                trip.totalSeats - acceptedSeats,
              )}, demandees : ${booking.numberOfSeats}.`,
            );
          }

          booking.status = BookingStatus.ACCEPTED;
          booking.acceptedAt = booking.acceptedAt ?? new Date();
          booking.cancelledAt = null;
          booking.rejectionReason = null;
          trip.availableSeats = Math.max(
            0,
            trip.totalSeats - seatsAfterAcceptance,
          );

          await tripRepository.save(trip);
          return bookingRepository.save(booking);
        }

        case BookingStatus.REJECTED: {
          if (
            ![BookingStatus.PENDING, BookingStatus.ACCEPTED].includes(oldStatus)
          ) {
            throw new BadRequestException(
              'Seule une reservation en attente ou acceptee peut etre rejetee',
            );
          }
          if (!updateStatusDto.rejectionReason?.trim()) {
            this.logger.warn(
              `Driver ${driverId} tried to reject booking ${bookingId} without reason`,
            );
            throw new BadRequestException(
              "Un motif de refus est requis lors du rejet d'une reservation",
            );
          }

          booking.status = BookingStatus.REJECTED;
          booking.rejectionReason = updateStatusDto.rejectionReason.trim();
          booking.acceptedAt = null;
          const savedBooking = await bookingRepository.save(booking);
          await this.recalculateAvailableSeatsForTrip(trip.id, manager);
          return savedBooking;
        }

        case BookingStatus.CANCELLED: {
          if (
            ![BookingStatus.PENDING, BookingStatus.ACCEPTED].includes(oldStatus)
          ) {
            throw new BadRequestException(
              'Seule une reservation en attente ou acceptee peut etre annulee',
            );
          }

          booking.status = BookingStatus.CANCELLED;
          booking.cancelledAt = new Date();
          const savedBooking = await bookingRepository.save(booking);
          await this.recalculateAvailableSeatsForTrip(trip.id, manager);
          return savedBooking;
        }

        case BookingStatus.COMPLETED: {
          if (oldStatus !== BookingStatus.ACCEPTED) {
            throw new BadRequestException(
              'Seule une reservation acceptee peut etre terminee',
            );
          }
          if (!this.hasBookingBeenPickedUpForRideProgress(booking)) {
            throw new BadRequestException(
              'La prise en charge doit etre detectee avant de terminer la reservation',
            );
          }

          const now = new Date();
          booking.pickedUp = true;
          booking.pickedUpAt = booking.pickedUpAt ?? now;
          booking.pickedUpConfirmedByPassenger = true;
          booking.pickedUpConfirmedAt = booking.pickedUpConfirmedAt ?? now;
          booking.droppedOff = true;
          booking.droppedOffAt = booking.droppedOffAt ?? now;
          booking.droppedOffConfirmedByPassenger = true;
          booking.droppedOffConfirmedAt = booking.droppedOffConfirmedAt ?? now;
          booking.status = BookingStatus.COMPLETED;
          const savedBooking = await bookingRepository.save(booking);
          await this.recalculateAvailableSeatsForTrip(trip.id, manager);
          return savedBooking;
        }

        default:
          throw new BadRequestException(
            `Transition de reservation non autorisee vers ${nextStatus}`,
          );
      }
    });

    if (
      updateStatusDto.status === BookingStatus.CANCELLED ||
      updateStatusDto.status === BookingStatus.REJECTED
    ) {
      await this.refundPointsPaymentIfNeeded(updatedBooking);
    }

    if (updateStatusDto.status === BookingStatus.COMPLETED) {
      await this.settlePaymentAfterArrival(updatedBooking);
    }

    await this.invalidateBookingCaches(updatedBooking);

    this.logger.log(
      `Booking ${bookingId} status updated to ${updateStatusDto.status} successfully`,
    );
    return updatedBooking;
  }

  private isFreshLocationUpdate(
    updatedAt?: Date | string | null,
    now = new Date(),
  ): boolean {
    return isFreshLocationTimestamp(
      updatedAt,
      now,
      this.AUTO_PROGRESS_LOCATION_FRESHNESS_MS,
    );
  }

  private async geocodeAddressToPoint(
    address?: string | null,
    reference?: string | null,
    context = 'address',
  ): Promise<Point | null> {
    const addressText = address?.trim();
    if (!addressText) {
      return null;
    }

    const referenceText = reference?.trim();
    const queries = referenceText
      ? [`${addressText}, ${referenceText}`, addressText]
      : [addressText];
    let bestResult: {
      lat: number;
      lng: number;
      formattedAddress: string;
      locationType?: string;
      partialMatch?: boolean;
    } | null = null;
    let bestRank = Number.POSITIVE_INFINITY;

    for (const query of queries) {
      try {
        const result = await this.googleMapsService.geocode({
          address: query,
          region: 'CD',
          components: 'country:CD',
        });
        const rank = this.getGeocodePrecisionRank(result);
        if (rank < bestRank) {
          bestResult = result;
          bestRank = rank;
        }
        if (rank === 0) {
          break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Unable to geocode ${context} "${query}": ${message}`);
      }
    }

    if (!bestResult) {
      return null;
    }

    this.logger.debug(
      `Geocoded ${context} to "${bestResult.formattedAddress}" (${bestResult.locationType ?? 'UNKNOWN'}${bestResult.partialMatch ? ', partial match' : ''})`,
    );
    return this.buildPointFromLatLng(bestResult.lat, bestResult.lng);
  }

  private getGeocodePrecisionRank(result: {
    locationType?: string;
    partialMatch?: boolean;
  }): number {
    const isPrecise = ['ROOFTOP', 'RANGE_INTERPOLATED'].includes(
      result.locationType ?? '',
    );

    if (isPrecise && !result.partialMatch) {
      return 0;
    }
    if (!result.partialMatch) {
      return 1;
    }
    if (isPrecise) {
      return 2;
    }
    return 3;
  }

  async create(
    passengerId: string,
    createBookingDto: CreateBookingDto,
  ): Promise<Booking> {
    this.logger.log(
      `Creating booking for passenger ${passengerId} on trip ${createBookingDto.tripId} (${createBookingDto.numberOfSeats} seats)`,
    );

    // Validate numberOfSeats input
    if (!createBookingDto.numberOfSeats || createBookingDto.numberOfSeats < 1) {
      throw new BadRequestException('Le nombre de places doit être au moins 1');
    }

    if (createBookingDto.numberOfSeats > this.MAX_SEATS_PER_PASSENGER) {
      throw new BadRequestException(
        `Pour des raisons de securite du conducteur, vous ne pouvez pas reserver plus de ${this.MAX_SEATS_PER_PASSENGER} places par trajet`,
      );
    }

    const trip = await this.tripRepository.findOne({
      where: { id: createBookingDto.tripId },
      relations: ['bookings', 'driver'],
    });

    if (!trip) {
      this.logger.warn(
        `Booking creation failed: Trip ${createBookingDto.tripId} not found`,
      );
      throw new NotFoundException('Trajet non trouvé');
    }

    if (trip.driverId === passengerId) {
      this.logger.warn(
        `Booking creation failed: Passenger ${passengerId} tried to book own trip ${createBookingDto.tripId}`,
      );
      throw new BadRequestException(
        'Vous ne pouvez pas réserver votre propre trajet',
      );
    }

    // Vérifier que le trajet a des places totales définies
    if (trip.totalSeats === null || trip.totalSeats === undefined) {
      this.logger.warn(
        `Booking creation failed: Trip ${createBookingDto.tripId} has no totalSeats defined`,
      );
      throw new BadRequestException(
        "Ce trajet n'a pas de nombre de places défini",
      );
    }

    // Vérifier que availableSeats est défini et valide
    if (trip.availableSeats === null || trip.availableSeats === undefined) {
      this.logger.warn(
        `Booking creation failed: Trip ${createBookingDto.tripId} has no availableSeats defined`,
      );
      throw new BadRequestException(
        "Ce trajet n'a pas de places disponibles définies",
      );
    }

    // Allow booking for PENDING trips OR ACTIVE trips with available seats
    const isPendingTrip = trip.status === TripStatus.PENDING;
    const isActiveTripWithSeats =
      trip.status === TripStatus.ACTIVE && trip.availableSeats > 0;

    if (!isPendingTrip && !isActiveTripWithSeats) {
      this.logger.warn(
        `Booking creation failed: Trip ${createBookingDto.tripId} is not available for booking (status: ${trip.status}, availableSeats: ${trip.availableSeats})`,
      );
      throw new BadRequestException(
        "Ce trajet n'est pas disponible pour la réservation. Seuls les trajets en attente ou les trajets actifs avec des places disponibles peuvent être réservés.",
      );
    }

    // Vérifier les places disponibles directement (les places sont déduites immédiatement à la création)
    // Le maximum de places qu'un utilisateur peut réserver est limité uniquement par les places disponibles
    const effectiveAvailableSeats =
      this.calculateAvailableSeatsFromAcceptedBookings(
        trip,
        trip.bookings ?? [],
      );

    if (effectiveAvailableSeats < createBookingDto.numberOfSeats) {
      this.logger.warn(
        `Booking creation failed: Not enough seats on trip ${createBookingDto.tripId} (requested: ${createBookingDto.numberOfSeats}, available: ${effectiveAvailableSeats}, total: ${trip.totalSeats})`,
      );
      throw new BadRequestException(
        `Pas assez de places disponibles. Disponibles : ${effectiveAvailableSeats}, demandees : ${createBookingDto.numberOfSeats}. Vous pouvez reserver jusqu'a ${effectiveAvailableSeats} place(s).`,
      );
    }

    // Vérification supplémentaire : s'assurer que le nombre de places demandées ne dépasse pas le total
    if (createBookingDto.numberOfSeats > trip.totalSeats) {
      this.logger.warn(
        `Booking creation failed: Requested seats (${createBookingDto.numberOfSeats}) exceed total seats (${trip.totalSeats})`,
      );
      throw new BadRequestException(
        `Le nombre de places demandé (${createBookingDto.numberOfSeats}) dépasse le nombre total de places du véhicule (${trip.totalSeats})`,
      );
    }

    // Check if user already has a pending or accepted booking for this trip
    // For ACTIVE trips, also check ACCEPTED bookings to prevent double booking
    const existingBooking = await this.bookingRepository.findOne({
      where: {
        tripId: createBookingDto.tripId,
        passengerId,
        status: In([BookingStatus.PENDING, BookingStatus.ACCEPTED]),
      },
    });

    if (existingBooking) {
      this.logger.warn(
        `Booking creation failed: Passenger ${passengerId} already has pending or accepted booking for trip ${createBookingDto.tripId}`,
      );
      throw new BadRequestException(
        'Vous avez deja une reservation en attente ou acceptee pour ce trajet',
      );
    }

    // Use trip's departure location as default if passenger origin is not specified
    const passengerOrigin =
      createBookingDto.passengerOrigin || trip.departureLocation;
    const passengerOriginPoint = createBookingDto.passengerOriginCoordinates
      ? this.buildTripScopedPointFromLatLng(
          createBookingDto.passengerOriginCoordinates.latitude,
          createBookingDto.passengerOriginCoordinates.longitude,
          trip,
          'du point de depart passager',
        )
      : createBookingDto.passengerOrigin
        ? this.sanitizePointForTrip(
            await this.geocodeAddressToPoint(
              createBookingDto.passengerOrigin,
              createBookingDto.passengerOriginReference,
              'passenger origin',
            ),
            trip,
          )
        : trip.departurePoint;

    // Use trip's arrival location as default if passenger destination is not specified
    const passengerDestination =
      createBookingDto.passengerDestination || trip.arrivalLocation;
    const passengerDestinationPoint =
      createBookingDto.passengerDestinationCoordinates
        ? this.buildTripScopedPointFromLatLng(
            createBookingDto.passengerDestinationCoordinates.latitude,
            createBookingDto.passengerDestinationCoordinates.longitude,
            trip,
            "de l'arrivee passager",
          )
        : createBookingDto.passengerDestination
          ? this.sanitizePointForTrip(
              await this.geocodeAddressToPoint(
                createBookingDto.passengerDestination,
                createBookingDto.passengerDestinationReference,
                'passenger destination',
              ),
              trip,
            )
          : trip.arrivalPoint;

    const paymentAmount = this.calculateBookingPaymentAmount(
      trip,
      createBookingDto.numberOfSeats,
    );
    const paymentCurrency = this.getTripPaymentCurrency();
    const paymentMode = createBookingDto.paymentMode ?? TripPaymentMode.CASH;

    const booking = this.bookingRepository.create({
      tripId: createBookingDto.tripId,
      passengerId,
      numberOfSeats: createBookingDto.numberOfSeats,
      passengerOrigin: passengerOrigin || null,
      passengerOriginReference:
        createBookingDto.passengerOriginReference?.trim() || null,
      passengerOriginPoint,
      passengerDestination: passengerDestination || null,
      passengerDestinationReference:
        createBookingDto.passengerDestinationReference?.trim() || null,
      passengerDestinationPoint,
      paymentStatus:
        paymentAmount > 0 &&
        [TripPaymentMode.ELECTRONIC, TripPaymentMode.POINTS].includes(
          paymentMode,
        )
          ? BookingPaymentStatus.PENDING
          : BookingPaymentStatus.NOT_REQUIRED,
      paymentAmount,
      paymentCurrency,
      paymentMode,
    });

    const savedBooking = await this.bookingRepository.save(booking);

    await this.recalculateAvailableSeatsForTrip(trip.id);

    // Invalidate cache
    await this.cacheService.del(
      CacheService.getBookingsByTripKey(createBookingDto.tripId),
    );
    await this.cacheService.del(
      CacheService.getBookingsByPassengerKey(passengerId),
    );
    await this.cacheService.del(
      CacheService.getTripKey(createBookingDto.tripId),
    );

    this.logger.log(
      `Booking created successfully: ${savedBooking.id} for passenger ${passengerId} on trip ${createBookingDto.tripId}. Seats will be deducted when the booking is accepted.`,
    );

    await this.notifyDriverOfNewBooking(trip, passengerId, savedBooking);
    return savedBooking;
  }

  async findAllByPassenger(passengerId: string): Promise<Booking[]> {
    this.logger.debug(`Fetching bookings for passenger: ${passengerId}`);

    const cacheKey = CacheService.getBookingsByPassengerKey(passengerId);
    const cached = await this.cacheService.get<Booking[]>(cacheKey);

    if (cached) {
      this.logger.debug(
        `Returning ${cached.length} bookings from cache for passenger ${passengerId}`,
      );
      return cached;
    }

    const bookings = await this.bookingRepository.find({
      where: { passengerId },
      relations: ['trip', 'trip.driver'],
      order: { createdAt: 'DESC' },
    });

    await this.attachActiveInterruptionRequestsToBookings(bookings);
    await this.cacheService.set(cacheKey, bookings, this.CACHE_TTL);
    this.logger.debug(
      `Fetched ${bookings.length} bookings from database for passenger ${passengerId}`,
    );
    return bookings;
  }

  async findAllByTrip(tripId: string, driverId: string): Promise<Booking[]> {
    this.logger.debug(
      `Fetching bookings for trip ${tripId} by driver ${driverId}`,
    );

    const trip = await this.tripRepository.findOne({
      where: { id: tripId, driverId },
    });

    if (!trip) {
      this.logger.warn(
        `Get bookings failed: Trip ${tripId} not found for driver ${driverId}`,
      );
      throw new NotFoundException('Trajet non trouvé');
    }

    const cacheKey = CacheService.getBookingsByTripKey(tripId);
    const cached = await this.cacheService.get<Booking[]>(cacheKey);

    if (cached) {
      this.logger.debug(
        `Returning ${cached.length} bookings from cache for trip ${tripId}`,
      );
      return cached;
    }

    const bookings = await this.bookingRepository.find({
      where: { tripId },
      relations: ['passenger', 'trip', 'trip.driver'],
      order: { createdAt: 'DESC' },
    });

    await this.attachActiveInterruptionRequestsToBookings(bookings);
    await this.cacheService.set(cacheKey, bookings, this.CACHE_TTL);
    this.logger.debug(
      `Fetched ${bookings.length} bookings from database for trip ${tripId}`,
    );
    return bookings;
  }

  async findOne(id: string): Promise<Booking> {
    this.logger.debug(`Fetching booking: ${id}`);

    const cacheKey = CacheService.getBookingKey(id);
    const cached = await this.cacheService.get<Booking>(cacheKey);

    if (cached) {
      this.logger.debug(`Booking ${id} returned from cache`);
      return cached;
    }

    const booking = await this.bookingRepository.findOne({
      where: { id },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      this.logger.warn(`Booking not found: ${id}`);
      throw new NotFoundException('Réservation non trouvée');
    }

    await this.attachActiveInterruptionRequestsToBookings([booking]);
    await this.cacheService.set(cacheKey, booking, this.CACHE_TTL);
    this.logger.debug(`Booking ${id} fetched from database`);
    return booking;
  }

  private async attachActiveInterruptionRequestsToBookings(
    bookings: Booking[],
  ): Promise<void> {
    if (bookings.length === 0) {
      return;
    }

    const bookingIds = bookings.map((booking) => booking.id).filter(Boolean);
    const tripIds = Array.from(
      new Set(bookings.map((booking) => booking.tripId).filter(Boolean)),
    );

    const passengerRequests =
      bookingIds.length > 0
        ? await this.passengerTripInterruptionRepository.find({
            where: {
              bookingId: In(bookingIds),
              status: TripInterruptionStatus.PENDING,
            },
            order: { createdAt: 'DESC' },
          })
        : [];
    const passengerRequestByBookingId = new Map<
      string,
      PassengerTripInterruptionRequest
    >();
    for (const request of passengerRequests) {
      if (!passengerRequestByBookingId.has(request.bookingId)) {
        passengerRequestByBookingId.set(request.bookingId, request);
      }
    }

    const driverRequests =
      tripIds.length > 0
        ? await this.driverTripInterruptionRepository.find({
            where: {
              tripId: In(tripIds),
              status: TripInterruptionStatus.PENDING,
            },
            relations: ['confirmations', 'confirmations.passenger'],
            order: { createdAt: 'DESC' },
          })
        : [];
    const driverRequestByTripId = new Map<
      string,
      DriverTripInterruptionRequest
    >();
    for (const request of driverRequests) {
      if (!driverRequestByTripId.has(request.tripId)) {
        driverRequestByTripId.set(request.tripId, request);
      }
    }

    for (const booking of bookings) {
      const driverRequest = driverRequestByTripId.get(booking.tripId) ?? null;
      booking.interruptionRequest =
        passengerRequestByBookingId.get(booking.id) ?? null;
      booking.tripInterruptionRequest = driverRequest;
      if (booking.trip) {
        booking.trip.interruptionRequest = driverRequest;
      }
    }
  }

  async requestPassengerTripInterruption(
    bookingId: string,
    passengerId: string,
    dto: RequestTripInterruptionDto,
  ): Promise<Booking> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Reservation non trouvee');
    }

    if (booking.trip.status !== TripStatus.ACTIVE) {
      throw new BadRequestException(
        'Vous ne pouvez demander une interruption que pendant un trajet en cours',
      );
    }

    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException(
        'Seule une reservation acceptee peut etre interrompue',
      );
    }

    if (!this.hasBookingBeenPickedUpForRideProgress(booking)) {
      throw new BadRequestException(
        'Vous devez etre a bord avant de demander une interruption',
      );
    }

    if (this.hasBookingBeenDroppedOffForTripEnd(booking)) {
      throw new BadRequestException('Cette reservation est deja terminee');
    }

    const existingRequest =
      await this.passengerTripInterruptionRepository.findOne({
        where: {
          bookingId,
          status: TripInterruptionStatus.PENDING,
        },
      });

    if (existingRequest) {
      throw new BadRequestException(
        "Une demande d'interruption est deja en attente",
      );
    }

    const request = this.passengerTripInterruptionRepository.create({
      tripId: booking.tripId,
      bookingId: booking.id,
      passengerId: booking.passengerId,
      reason: dto.reason ?? TripInterruptionReason.OTHER,
      note: dto.note ?? null,
      status: TripInterruptionStatus.PENDING,
      requestedLocation: this.buildInterruptionPoint(
        dto.coordinates,
        booking.trip,
      ),
      requestedAt: new Date(),
      confirmedAt: null,
      rejectedAt: null,
      cancelledAt: null,
      completedAt: null,
      confirmedByDriverId: null,
      rejectedByDriverId: null,
      rejectionReason: null,
    });

    await this.passengerTripInterruptionRepository.save(request);
    await this.invalidateBookingCaches(booking);
    await this.notifyDriverAboutPassengerInterruptionRequest(booking, request);

    return this.findOne(booking.id);
  }

  async cancelPassengerTripInterruption(
    bookingId: string,
    passengerId: string,
  ): Promise<Booking> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Reservation non trouvee');
    }

    const request = await this.passengerTripInterruptionRepository.findOne({
      where: {
        bookingId,
        status: TripInterruptionStatus.PENDING,
      },
    });

    if (!request) {
      throw new NotFoundException("Aucune demande d'interruption en attente");
    }

    request.status = TripInterruptionStatus.CANCELLED;
    request.cancelledAt = new Date();
    await this.passengerTripInterruptionRepository.save(request);
    await this.invalidateBookingCaches(booking);

    return this.findOne(booking.id);
  }

  async confirmPassengerTripInterruption(
    bookingId: string,
    driverId: string,
  ): Promise<Booking> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Reservation non trouvee');
    }

    if (booking.trip.driverId !== driverId) {
      throw new ForbiddenException(
        "Vous n'etes pas le conducteur de ce trajet",
      );
    }

    const request = await this.passengerTripInterruptionRepository.findOne({
      where: {
        bookingId,
        status: TripInterruptionStatus.PENDING,
      },
    });

    if (!request) {
      throw new NotFoundException("Aucune demande d'interruption en attente");
    }

    await this.completeBookingByTripInterruption(
      booking.id,
      request.requestedLocation ?? booking.trip.currentLocation,
    );

    const now = new Date();
    request.status = TripInterruptionStatus.COMPLETED;
    request.confirmedAt = now;
    request.completedAt = now;
    request.confirmedByDriverId = driverId;
    await this.passengerTripInterruptionRepository.save(request);
    await this.invalidateBookingCaches(booking);
    await this.notifyPassengerAboutPassengerInterruptionDecision(booking, true);

    return this.findOne(booking.id);
  }

  async rejectPassengerTripInterruption(
    bookingId: string,
    driverId: string,
    reason?: string,
  ): Promise<Booking> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Reservation non trouvee');
    }

    if (booking.trip.driverId !== driverId) {
      throw new ForbiddenException(
        "Vous n'etes pas le conducteur de ce trajet",
      );
    }

    const request = await this.passengerTripInterruptionRepository.findOne({
      where: {
        bookingId,
        status: TripInterruptionStatus.PENDING,
      },
    });

    if (!request) {
      throw new NotFoundException("Aucune demande d'interruption en attente");
    }

    request.status = TripInterruptionStatus.REJECTED;
    request.rejectedAt = new Date();
    request.rejectedByDriverId = driverId;
    request.rejectionReason = reason ?? null;
    await this.passengerTripInterruptionRepository.save(request);
    await this.invalidateBookingCaches(booking);
    await this.notifyPassengerAboutPassengerInterruptionDecision(
      booking,
      false,
    );

    return this.findOne(booking.id);
  }

  async completeBookingByTripInterruption(
    bookingId: string,
    interruptionLocation?: Point | null,
  ): Promise<Booking> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Reservation non trouvee');
    }

    if (this.hasBookingBeenDroppedOffForTripEnd(booking)) {
      return booking;
    }

    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException(
        'Seule une reservation acceptee peut etre interrompue',
      );
    }

    if (!this.hasBookingBeenPickedUpForRideProgress(booking)) {
      throw new BadRequestException(
        'La prise en charge du passager doit etre confirmee avant interruption',
      );
    }

    const fareAdjustment = await this.calculateDistanceBasedFareAdjustment(
      booking,
      interruptionLocation ??
        booking.passengerCurrentLocation ??
        booking.trip.currentLocation,
    );

    if (fareAdjustment) {
      booking.originalPaymentAmount = fareAdjustment.originalAmount;
      booking.plannedDistanceMeters = fareAdjustment.plannedDistanceMeters;
      booking.travelledDistanceMeters = fareAdjustment.travelledDistanceMeters;
      booking.pricePerKilometer = fareAdjustment.pricePerKilometer;
      booking.fareAdjustmentAmount = fareAdjustment.adjustmentAmount;
      booking.fareAdjustedAt = booking.fareAdjustedAt ?? new Date();
      booking.paymentAmount = fareAdjustment.finalAmount;
      booking.paymentCurrency =
        booking.paymentCurrency || this.getTripPaymentCurrency();

      await this.bookingRepository.save(booking);

      if (
        fareAdjustment.adjustmentAmount > 0 &&
        [TripPaymentMode.ELECTRONIC, TripPaymentMode.POINTS].includes(
          booking.paymentMode,
        ) &&
        booking.paymentStatus === BookingPaymentStatus.SUCCEEDED
      ) {
        await this.walletService.creditBookingFareAdjustment(
          booking,
          fareAdjustment.adjustmentAmount,
        );
      }
    }

    const now = new Date();
    booking.pickedUp = true;
    booking.pickedUpAt = booking.pickedUpAt ?? now;
    booking.pickedUpConfirmedByPassenger = true;
    booking.pickedUpConfirmedAt = booking.pickedUpConfirmedAt ?? now;
    booking.pickupDetectionMethod =
      booking.pickupDetectionMethod ?? 'manual_driver_recovery';
    booking.droppedOff = true;
    booking.droppedOffAt = booking.droppedOffAt ?? now;
    booking.droppedOffConfirmedByPassenger = true;
    booking.droppedOffConfirmedAt = booking.droppedOffConfirmedAt ?? now;
    booking.status = BookingStatus.COMPLETED;

    let savedBooking = await this.bookingRepository.save(booking);
    savedBooking = await this.settlePaymentAfterArrival(savedBooking);
    await this.touchTripInteraction(savedBooking.tripId);
    await this.invalidateBookingCaches(savedBooking);

    return savedBooking;
  }

  private async calculateDistanceBasedFareAdjustment(
    booking: Booking,
    interruptionLocation?: Point | null,
  ): Promise<{
    originalAmount: number;
    finalAmount: number;
    adjustmentAmount: number;
    plannedDistanceMeters: number;
    travelledDistanceMeters: number;
    pricePerKilometer: number;
  } | null> {
    const storedOriginalAmount = Number(
      booking.originalPaymentAmount ?? booking.paymentAmount,
    );
    const originalAmount =
      Number.isFinite(storedOriginalAmount) && storedOriginalAmount > 0
        ? storedOriginalAmount
        : this.calculateBookingPaymentAmount(
            booking.trip,
            booking.numberOfSeats,
          );

    if (
      booking.fareAdjustedAt &&
      booking.plannedDistanceMeters !== null &&
      booking.plannedDistanceMeters !== undefined &&
      booking.travelledDistanceMeters !== null &&
      booking.travelledDistanceMeters !== undefined &&
      booking.pricePerKilometer !== null &&
      booking.pricePerKilometer !== undefined &&
      booking.fareAdjustmentAmount !== null &&
      booking.fareAdjustmentAmount !== undefined
    ) {
      return {
        originalAmount,
        finalAmount: Number(booking.paymentAmount ?? originalAmount),
        adjustmentAmount: Number(booking.fareAdjustmentAmount),
        plannedDistanceMeters: booking.plannedDistanceMeters,
        travelledDistanceMeters: booking.travelledDistanceMeters,
        pricePerKilometer: Number(booking.pricePerKilometer),
      };
    }

    const origin =
      booking.passengerOriginPoint ?? booking.trip.departurePoint ?? null;
    const destination =
      booking.passengerDestinationPoint ?? booking.trip.arrivalPoint ?? null;

    if (
      originalAmount <= 0 ||
      !origin ||
      !destination ||
      !interruptionLocation
    ) {
      return null;
    }

    const plannedDistanceMeters = await this.calculateRouteDistanceMeters(
      origin,
      destination,
      `booking ${booking.id} planned route`,
    );
    const rawTravelledDistanceMeters = await this.calculateRouteDistanceMeters(
      origin,
      interruptionLocation,
      `booking ${booking.id} travelled route`,
    );

    if (
      plannedDistanceMeters === null ||
      plannedDistanceMeters <= 0 ||
      rawTravelledDistanceMeters === null ||
      rawTravelledDistanceMeters < 0
    ) {
      return null;
    }

    const travelledDistanceMeters = Math.min(
      plannedDistanceMeters,
      Math.max(0, rawTravelledDistanceMeters),
    );
    const pricePerKilometer = this.roundMoney(
      originalAmount / (plannedDistanceMeters / 1000),
    );
    const finalAmount = Math.min(
      originalAmount,
      this.roundMoney(
        originalAmount * (travelledDistanceMeters / plannedDistanceMeters),
      ),
    );

    return {
      originalAmount,
      finalAmount,
      adjustmentAmount: this.roundMoney(originalAmount - finalAmount),
      plannedDistanceMeters,
      travelledDistanceMeters,
      pricePerKilometer,
    };
  }

  private async calculateRouteDistanceMeters(
    originPoint: Point,
    destinationPoint: Point,
    context: string,
  ): Promise<number | null> {
    const origin = this.pointToLatLng(originPoint);
    const destination = this.pointToLatLng(destinationPoint);
    if (!origin || !destination) {
      return null;
    }

    try {
      const directions = await this.googleMapsService.getDirections({
        origin: { lat: origin.latitude, lng: origin.longitude },
        destination: {
          lat: destination.latitude,
          lng: destination.longitude,
        },
        mode: TravelMode.DRIVING,
        region: 'CD',
      });
      const legs = directions.routes?.[0]?.legs ?? [];
      const distanceMeters = legs.reduce(
        (sum, leg) => sum + (Number(leg.distance) || 0),
        0,
      );

      if (legs.length > 0 && distanceMeters >= 0) {
        return Math.round(distanceMeters);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Unable to calculate route distance for ${context}: ${message}`,
      );
    }

    const straightLineDistance = this.calculatePointDistanceMeters(
      originPoint,
      destinationPoint,
    );
    return straightLineDistance === null
      ? null
      : Math.round(straightLineDistance);
  }

  private roundMoney(value: number): number {
    return Math.round(Number(value) * 100) / 100;
  }

  private buildInterruptionPoint(
    coordinates: RequestTripInterruptionDto['coordinates'],
    trip: Trip,
  ): Point | null {
    if (!coordinates) {
      return null;
    }

    const coordinate = normalizeCoordinateForTrip(
      coordinates.latitude,
      coordinates.longitude,
      trip,
    );

    if (!coordinate) {
      throw new BadRequestException(
        "Position d'interruption invalide ou incoherente avec le trajet",
      );
    }

    return buildPointFromCoordinate(coordinate);
  }

  async initiateBookingPayment(
    bookingId: string,
    passengerId: string,
    dto: InitiatePaymentDto,
  ): Promise<BookingPaymentResponse> {
    this.logger.log(
      `Initiating trip payment for booking ${bookingId} by passenger ${passengerId}`,
    );

    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Reservation non trouvee');
    }

    this.ensurePassengerOwnsBooking(booking, passengerId);
    this.prepareBookingForElectronicPayment(booking);

    const amount = this.resolveBookingPaymentAmount(booking, booking.trip);
    const currency = this.getTripPaymentCurrency();

    booking.paymentAmount = amount;
    booking.paymentCurrency = currency;

    if (amount <= 0) {
      booking.paymentStatus = BookingPaymentStatus.NOT_REQUIRED;
      booking.paidAt = booking.paidAt ?? new Date();
      const savedBooking = await this.bookingRepository.save(booking);
      await this.invalidateBookingCaches(savedBooking);
      const response = this.buildPaymentResponse(savedBooking, null);
      this.logBookingPaymentResponse('Trip payment not required', response);
      return response;
    }

    if (booking.paymentStatus === BookingPaymentStatus.SUCCEEDED) {
      const paidPayment = await this.findCurrentPaymentForBooking(
        booking,
        passengerId,
      );
      const response = this.buildPaymentResponse(booking, paidPayment);
      this.logBookingPaymentResponse(
        'Trip payment already succeeded',
        response,
      );
      return response;
    }

    const reusablePayment = await this.findReusablePaymentForBooking(
      booking,
      passengerId,
      dto.method,
    );
    if (reusablePayment) {
      const savedBooking = await this.applyPaymentToBooking(
        booking,
        reusablePayment,
      );
      const response = this.buildPaymentResponse(savedBooking, reusablePayment);
      this.logBookingPaymentResponse(
        'Trip payment reused pending transaction',
        response,
      );
      return response;
    }

    const payment = await this.paymentsService.initiatePayment({
      userId: passengerId,
      purpose: PaymentPurpose.TRIP_BOOKING,
      relatedEntityType: this.BOOKING_RELATED_ENTITY_TYPE,
      relatedEntityId: booking.id,
      method: dto.method,
      phone: dto.phone,
      amount,
      currency,
      description: this.buildTripPaymentDescription(booking),
      callbackUrl: this.getBookingFlexPayCallbackUrl(),
      approveUrl: dto.approveUrl,
      cancelUrl: dto.cancelUrl,
      declineUrl: dto.declineUrl,
      referencePrefix: 'TRIP',
    });

    const savedBooking = await this.applyPaymentToBooking(booking, payment);
    this.logger.log(
      `Trip payment initialized: bookingId=${savedBooking.id}, paymentId=${payment.id}, amount=${amount} ${currency}`,
    );

    const response = this.buildPaymentResponse(savedBooking, payment);
    this.logBookingPaymentResponse('Trip payment initialized', response);
    return response;
  }

  async handleFlexPayCallback(
    dto: FlexPayCallbackDto,
  ): Promise<BookingFlexPayCallbackResponse> {
    this.logger.log('Booking FlexPay callback received');

    const payment = await this.paymentsService.handleFlexPayCallback(dto);
    const booking = await this.findBookingForPayment(payment);
    const savedBooking = await this.applyPaymentToBooking(booking, payment);

    this.logger.log(
      `Booking payment callback applied: bookingId=${savedBooking.id}, paymentId=${payment.id}, paymentStatus=${payment.status}, bookingPaymentStatus=${savedBooking.paymentStatus}`,
    );

    const response = this.buildCallbackResponse(
      savedBooking,
      payment,
      payment.status === PaymentStatus.SUCCEEDED,
    );
    this.logger.log(
      `Booking payment callback response: response=${this.paymentsService.formatLogPayload(response)}`,
    );
    return response;
  }

  async checkBookingPaymentStatus(
    passengerId: string,
    orderNumber: string,
  ): Promise<BookingPaymentResponse> {
    this.logger.log(
      `Booking payment status check requested: passengerId=${passengerId}, orderNumber=${orderNumber}`,
    );

    const payment = await this.paymentsService.checkPaymentStatus(
      orderNumber,
      passengerId,
    );
    const booking = await this.findBookingForPayment(payment, passengerId);
    const savedBooking = await this.applyPaymentToBooking(booking, payment);

    const response = this.buildPaymentResponse(savedBooking, payment);
    this.logBookingPaymentResponse('Booking payment status check', response);
    return response;
  }

  async updateStatus(
    bookingId: string,
    driverId: string,
    updateStatusDto: UpdateBookingStatusDto,
  ): Promise<Booking> {
    this.logger.log(
      `Updating booking ${bookingId} status to ${updateStatusDto.status} by driver ${driverId}`,
    );

    return this.updateStatusTransactionally(
      bookingId,
      driverId,
      updateStatusDto,
    );
  }

  async cancel(bookingId: string, userId: string): Promise<void> {
    this.logger.log(`Cancelling booking ${bookingId} by user ${userId}`);

    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['passenger', 'trip', 'trip.driver'],
    });

    if (!booking) {
      this.logger.warn(
        `Booking cancellation failed: Booking ${bookingId} not found`,
      );
      throw new NotFoundException('Réservation non trouvée');
    }

    const isPassenger = booking.passengerId === userId;
    const isDriver = booking.trip.driverId === userId;

    if (!isPassenger && !isDriver) {
      this.logger.warn(
        `Booking cancellation failed: User ${userId} is not allowed to cancel booking ${bookingId}`,
      );
      throw new ForbiddenException('Accès refusé');
    }

    if (isDriver && booking.status !== BookingStatus.ACCEPTED) {
      this.logger.warn(
        `Booking cancellation failed: Driver ${userId} tried to cancel booking ${bookingId} with status ${booking.status}`,
      );
      throw new BadRequestException(
        'Le conducteur peut annuler uniquement une réservation acceptée',
      );
    }

    if (
      isDriver &&
      (booking.pickedUp || booking.pickedUpConfirmedByPassenger)
    ) {
      this.logger.warn(
        `Booking cancellation failed: Driver ${userId} tried to cancel booking ${bookingId} after pickup`,
      );
      throw new BadRequestException(
        "Impossible d'annuler cette réservation : le passager a déjà embarqué",
      );
    }

    if (
      booking.status === BookingStatus.COMPLETED ||
      booking.status === BookingStatus.NO_SHOW ||
      booking.status === BookingStatus.BOARDING_UNCERTAIN
    ) {
      this.logger.warn(
        `Booking cancellation failed: Booking ${bookingId} is already terminal (${booking.status})`,
      );
      throw new BadRequestException(
        "Impossible d'annuler une reservation deja terminee",
      );
    }

    const oldStatus = booking.status;
    const trip = await this.tripRepository.findOne({
      where: { id: booking.tripId },
      relations: ['driver'],
    });

    if (!trip) {
      throw new NotFoundException('Trajet non trouvé');
    }

    booking.status = BookingStatus.CANCELLED;
    booking.cancelledAt = new Date();
    await this.bookingRepository.save(booking);
    await this.refundPointsPaymentIfNeeded(booking);

    // Remettre les places disponibles si la réservation était en PENDING ou ACCEPTED
    if (oldStatus === BookingStatus.ACCEPTED) {
      const newAvailableSeats = await this.recalculateAvailableSeatsForTrip(
        trip.id,
      );
      this.logger.log(
        `Restored ${booking.numberOfSeats} seats for trip ${trip.id} (booking ${bookingId} cancelled by ${isDriver ? 'driver' : 'passenger'}). New available seats: ${newAvailableSeats} (totalSeats: ${trip.totalSeats})`,
      );
    }

    // Si c'est un trajet privé, l'annuler avant le départ ou le terminer s'il a démarré.
    if (isPassenger && trip.isPrivate) {
      const wasPending = trip.status === TripStatus.PENDING && !trip.startedAt;
      this.logger.log(
        `Private trip ${trip.id} - Passenger cancelled booking. ${wasPending ? 'Cancelling' : 'Completing'} trip automatically.`,
      );

      trip.status = wasPending ? TripStatus.CANCELLED : TripStatus.COMPLETED;
      if (!wasPending) {
        trip.completedAt = new Date();
      }
      await this.tripRepository.save(trip);

      // Notifier le driver
      await this.notifyDriverAboutPrivateTripCancellation(trip, booking);
    }

    if (isDriver) {
      await this.notifyPassengerOfStatusChange(
        booking,
        BookingStatus.CANCELLED,
      );
    }

    // Invalidate cache
    await this.cacheService.del(CacheService.getBookingKey(bookingId));
    await this.cacheService.del(
      CacheService.getBookingsByPassengerKey(booking.passengerId),
    );
    await this.cacheService.del(
      CacheService.getBookingsByTripKey(booking.tripId),
    );
    await this.cacheService.del(CacheService.getTripKey(booking.tripId));

    this.logger.log(`Booking ${bookingId} cancelled successfully!`);
  }

  /**
   * Notifie le conducteur qu'un trajet privé a été terminé à cause de l'annulation du passager
   */
  private async notifyDriverAboutPrivateTripCancellation(
    trip: Trip,
    cancelledBooking: Booking,
  ): Promise<void> {
    try {
      if (!trip.driver?.fcmToken) {
        this.logger.debug(
          `Driver ${trip.driverId} has no FCM token, skipping notification`,
        );
        return;
      }

      const passengerName = cancelledBooking.passenger
        ? `${cancelledBooking.passenger.firstName} ${cancelledBooking.passenger.lastName}`
        : 'Le passager';

      const wasCancelledBeforeStart = trip.status === TripStatus.CANCELLED;
      const title = wasCancelledBeforeStart
        ? '🚫 Trajet annulé'
        : '🚫 Trajet terminé';
      const body = `${passengerName} a annulé sa réservation. Le trajet privé de ${trip.departureLocation} à ${trip.arrivalLocation} a été automatiquement ${wasCancelledBeforeStart ? 'annulé' : 'terminé'}.`;

      const data = {
        type: 'private_trip_cancelled',
        tripId: trip.id,
        bookingId: cancelledBooking.id,
        passengerId: cancelledBooking.passengerId,
        departureLocation: trip.departureLocation,
        arrivalLocation: trip.arrivalLocation,
      };

      await this.notificationService.sendNotification(
        trip.driver.fcmToken,
        title,
        body,
        data,
        trip.driverId,
      );
      this.logger.log(
        `Notified driver ${trip.driverId} about private trip ${trip.id} cancellation`,
      );
    } catch (error) {
      this.logger.error(
        `Error notifying driver about private trip cancellation ${trip.id}: ${error.message}`,
        error.stack,
      );
    }
  }

  async acceptBooking(bookingId: string, driverId: string): Promise<Booking> {
    const booking = await this.updateStatus(bookingId, driverId, {
      status: BookingStatus.ACCEPTED,
    });
    await this.notifyPassengerOfStatusChange(booking, BookingStatus.ACCEPTED);
    return booking;
  }

  async updatePaymentMode(
    bookingId: string,
    passengerId: string,
    paymentMode: TripPaymentMode,
  ): Promise<Booking> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
      relations: ['trip', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Reservation non trouvee');
    }

    if (
      [
        BookingStatus.CANCELLED,
        BookingStatus.REJECTED,
        BookingStatus.NO_SHOW,
        BookingStatus.BOARDING_UNCERTAIN,
        BookingStatus.EXPIRED,
      ].includes(booking.status)
    ) {
      throw new BadRequestException(
        'Le mode de paiement ne peut plus etre modifie',
      );
    }

    if (booking.paymentStatus === BookingPaymentStatus.SUCCEEDED) {
      throw new BadRequestException(
        'Impossible de changer un paiement deja confirme',
      );
    }

    if (booking.paymentMode === paymentMode) {
      if (
        booking.status === BookingStatus.COMPLETED &&
        paymentMode === TripPaymentMode.POINTS
      ) {
        return this.capturePointsPaymentForBooking(booking, booking.trip);
      }
      return booking;
    }

    const amount = this.resolveBookingPaymentAmount(booking, booking.trip);
    booking.paymentMode = paymentMode;
    booking.paymentAmount = amount;
    booking.paymentCurrency = this.getTripPaymentCurrency();
    booking.paymentReference = null;
    booking.paymentTransactionId = null;

    if (amount <= 0) {
      booking.paymentStatus = BookingPaymentStatus.NOT_REQUIRED;
      booking.paidAt = booking.paidAt ?? new Date();
    } else if (
      paymentMode === TripPaymentMode.POINTS ||
      paymentMode === TripPaymentMode.ELECTRONIC
    ) {
      booking.paymentStatus = BookingPaymentStatus.PENDING;
      booking.paidAt = null;
    } else {
      booking.paymentStatus = BookingPaymentStatus.NOT_REQUIRED;
      booking.paidAt = null;
    }

    let savedBooking = await this.bookingRepository.save(booking);
    if (
      savedBooking.status === BookingStatus.COMPLETED &&
      savedBooking.paymentMode === TripPaymentMode.POINTS
    ) {
      savedBooking = await this.capturePointsPaymentForBooking(
        savedBooking,
        savedBooking.trip,
      );
    }
    await this.invalidateBookingCaches(savedBooking);
    if (
      savedBooking.status === BookingStatus.COMPLETED &&
      savedBooking.paymentStatus === BookingPaymentStatus.SUCCEEDED
    ) {
      await this.finalizeCompletedBooking(savedBooking);
    }
    return savedBooking;
  }

  async rejectBooking(
    bookingId: string,
    driverId: string,
    reason: string,
  ): Promise<Booking> {
    const booking = await this.updateStatus(bookingId, driverId, {
      status: BookingStatus.REJECTED,
      rejectionReason: reason,
    });
    await this.notifyPassengerOfStatusChange(
      booking,
      BookingStatus.REJECTED,
      reason,
    );
    return booking;
  }

  async getDriverContact(bookingId: string, requesterId: string) {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'trip.driver'],
    });

    if (!booking) {
      throw new NotFoundException('Réservation non trouvée');
    }

    if (
      booking.passengerId !== requesterId &&
      booking.trip.driverId !== requesterId
    ) {
      throw new ForbiddenException('Accès refusé');
    }

    const driver = booking.trip.driver;

    if (!driver) {
      throw new NotFoundException('Conducteur non trouvé');
    }

    // Convert S3 key to presigned URL
    const profilePicture = driver.profilePicture
      ? await this.fileUploadService.getPresignedUrlIfS3Key(
          driver.profilePicture,
        )
      : null;

    return {
      driver: {
        id: driver.id,
        firstName: driver.firstName,
        lastName: driver.lastName,
        phone: driver.phone,
        profilePicture: profilePicture || driver.profilePicture,
      },
    };
  }

  private ensurePassengerOwnsBooking(
    booking: Booking,
    passengerId: string,
  ): void {
    if (booking.passengerId !== passengerId) {
      throw new ForbiddenException('Acces refuse');
    }
  }

  private ensureBookingCanBePaid(booking: Booking): void {
    if (booking.paymentMode === TripPaymentMode.POINTS) {
      throw new BadRequestException(
        'Cette reservation est reglee avec les jetons Zwanga',
      );
    }

    if (
      [
        BookingStatus.CANCELLED,
        BookingStatus.REJECTED,
        BookingStatus.NO_SHOW,
        BookingStatus.BOARDING_UNCERTAIN,
        BookingStatus.EXPIRED,
      ].includes(booking.status)
    ) {
      throw new BadRequestException(
        'Cette reservation ne peut plus etre payee',
      );
    }

    if (
      booking.status !== BookingStatus.COMPLETED &&
      !this.hasBookingBeenDroppedOffForTripEnd(booking)
    ) {
      throw new BadRequestException(
        "Le paiement du trajet est disponible uniquement apres l'arrivee",
      );
    }

    if (booking.trip?.status === TripStatus.CANCELLED) {
      throw new BadRequestException('Ce trajet ne peut plus etre paye');
    }
  }

  private prepareBookingForElectronicPayment(booking: Booking): void {
    this.ensureBookingCanBePaid(booking);

    if (booking.paymentMode === TripPaymentMode.ELECTRONIC) {
      return;
    }

    booking.paymentMode = TripPaymentMode.ELECTRONIC;
    booking.paymentStatus = BookingPaymentStatus.PENDING;
    booking.paymentReference = null;
    booking.paymentTransactionId = null;
    booking.paidAt = null;
  }

  private async capturePointsPaymentForBooking(
    booking: Booking,
    trip: Trip,
  ): Promise<Booking> {
    if (booking.paymentMode !== TripPaymentMode.POINTS) {
      return booking;
    }

    if (
      booking.status !== BookingStatus.COMPLETED &&
      !this.hasBookingBeenDroppedOffForTripEnd(booking)
    ) {
      throw new BadRequestException(
        "Le paiement en jetons est disponible uniquement apres l'arrivee",
      );
    }

    const amount = this.resolveBookingPaymentAmount(booking, trip);
    booking.paymentAmount = amount;
    booking.paymentCurrency = this.getTripPaymentCurrency();

    if (amount <= 0) {
      booking.paymentStatus = BookingPaymentStatus.NOT_REQUIRED;
      booking.paidAt = booking.paidAt ?? new Date();
      return this.bookingRepository.save(booking);
    }

    await this.walletService.payForBooking(booking, amount);
    booking.paymentStatus = BookingPaymentStatus.SUCCEEDED;
    booking.paidAt = booking.paidAt ?? new Date();
    return this.bookingRepository.save(booking);
  }

  private async settlePaymentAfterArrival(booking: Booking): Promise<Booking> {
    let completedBooking = booking;
    const trip =
      completedBooking.trip ??
      (await this.tripRepository.findOne({
        where: { id: completedBooking.tripId },
      }));

    if (!trip) {
      return completedBooking;
    }

    const amount = this.resolveBookingPaymentAmount(completedBooking, trip);
    completedBooking.paymentAmount = amount;
    completedBooking.paymentCurrency = this.getTripPaymentCurrency();

    if (amount <= 0 || completedBooking.paymentMode === TripPaymentMode.CASH) {
      completedBooking.paymentStatus = BookingPaymentStatus.NOT_REQUIRED;
      completedBooking.paidAt = null;
      completedBooking = await this.bookingRepository.save(completedBooking);
    } else if (
      completedBooking.paymentMode === TripPaymentMode.POINTS &&
      completedBooking.paymentStatus !== BookingPaymentStatus.SUCCEEDED
    ) {
      try {
        completedBooking = await this.capturePointsPaymentForBooking(
          completedBooking,
          trip,
        );
      } catch (error) {
        completedBooking.paymentStatus = BookingPaymentStatus.PENDING;
        completedBooking.paidAt = null;
        completedBooking = await this.bookingRepository.save(completedBooking);
        this.logger.warn(
          `Paiement en jetons differe apres arrivee pour la reservation ${completedBooking.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (
      amount <= 0 ||
      completedBooking.paymentMode === TripPaymentMode.CASH ||
      completedBooking.paymentStatus === BookingPaymentStatus.SUCCEEDED
    ) {
      await this.finalizeCompletedBooking(completedBooking);
    }

    return completedBooking;
  }

  private async refundPointsPaymentIfNeeded(
    booking: Booking,
    nextPaymentStatus = BookingPaymentStatus.CANCELLED,
  ): Promise<void> {
    if (
      booking.paymentMode !== TripPaymentMode.POINTS ||
      booking.paymentStatus !== BookingPaymentStatus.SUCCEEDED
    ) {
      return;
    }

    const refunded = await this.walletService.refundBookingPayment(booking);
    if (!refunded) {
      return;
    }

    booking.paymentStatus = nextPaymentStatus;
    booking.paidAt = null;
    await this.bookingRepository.save(booking);
  }

  private async finalizeCompletedBooking(booking: Booking): Promise<void> {
    const completedBooking =
      booking.trip && booking.trip.driverId
        ? booking
        : await this.bookingRepository.findOne({
            where: { id: booking.id },
            relations: ['trip', 'passenger'],
          });

    if (!completedBooking?.trip) {
      return;
    }

    const calculatedGrossAmount = this.calculateBookingPaymentAmount(
      completedBooking.trip,
      completedBooking.numberOfSeats,
    );
    const persistedAmount = Number(completedBooking.paymentAmount);
    const grossAmount =
      completedBooking.paymentAmount !== null &&
      completedBooking.paymentAmount !== undefined &&
      Number.isFinite(persistedAmount) &&
      persistedAmount >= 0
        ? persistedAmount
        : calculatedGrossAmount;

    if (
      grossAmount > 0 &&
      completedBooking.paymentMode !== TripPaymentMode.CASH &&
      completedBooking.paymentStatus !== BookingPaymentStatus.SUCCEEDED
    ) {
      this.logger.debug(
        `Financial finalization deferred for unpaid booking ${completedBooking.id}`,
      );
      return;
    }

    if (grossAmount > 0 && !completedBooking.paymentAmount) {
      completedBooking.paymentAmount = grossAmount;
      completedBooking.paymentCurrency = this.getTripPaymentCurrency();
      await this.bookingRepository.save(completedBooking);
    }

    await this.ensureLoyaltyDistanceForCompletedBooking(completedBooking);
    await this.walletService.awardLoyaltyForBooking(
      completedBooking,
      grossAmount,
    );
    await this.driverSettlementsService.recordCompletedBookingEarning(
      completedBooking,
    );
  }

  private async ensureLoyaltyDistanceForCompletedBooking(
    booking: Booking,
  ): Promise<void> {
    const existingDistance = Number(
      booking.travelledDistanceMeters ?? booking.plannedDistanceMeters ?? 0,
    );
    if (Number.isFinite(existingDistance) && existingDistance > 0) {
      return;
    }

    const origin =
      booking.passengerOriginPoint ?? booking.trip.departurePoint ?? null;
    const destination =
      booking.passengerDestinationPoint ?? booking.trip.arrivalPoint ?? null;
    if (!origin || !destination) {
      return;
    }

    const distanceMeters = await this.calculateRouteDistanceMeters(
      origin,
      destination,
      `booking ${booking.id} loyalty distance`,
    );
    if (!distanceMeters || distanceMeters <= 0) {
      return;
    }

    booking.plannedDistanceMeters =
      booking.plannedDistanceMeters ?? distanceMeters;
    booking.travelledDistanceMeters =
      booking.travelledDistanceMeters ?? distanceMeters;
    await this.bookingRepository.save(booking);
  }

  private calculateBookingPaymentAmount(
    trip: Trip,
    numberOfSeats: number,
  ): number {
    const pricePerSeat = Number(trip.pricePerSeat ?? 0);
    const seats = Number(numberOfSeats ?? 0);

    if (
      !Number.isFinite(pricePerSeat) ||
      !Number.isFinite(seats) ||
      pricePerSeat <= 0 ||
      seats <= 0 ||
      trip.isFree
    ) {
      return 0;
    }

    return Math.round(pricePerSeat * seats);
  }

  private resolveBookingPaymentAmount(booking: Booking, trip: Trip): number {
    const calculatedAmount = this.calculateBookingPaymentAmount(
      trip,
      booking.numberOfSeats,
    );
    const persistedAmount = Number(booking.paymentAmount);

    if (
      booking.fareAdjustedAt &&
      booking.paymentAmount !== null &&
      booking.paymentAmount !== undefined &&
      Number.isFinite(persistedAmount) &&
      persistedAmount >= 0
    ) {
      return persistedAmount;
    }

    return calculatedAmount;
  }

  private getTripPaymentCurrency(): string {
    return (
      this.configService.get<string>('TRIP_PAYMENT_CURRENCY')?.trim() ||
      this.DEFAULT_TRIP_PAYMENT_CURRENCY
    ).toUpperCase();
  }

  private async findCurrentPaymentForBooking(
    booking: Booking,
    passengerId?: string,
  ): Promise<PaymentTransaction | null> {
    if (booking.paymentTransactionId) {
      try {
        return await this.paymentsService.findTransactionById(
          booking.paymentTransactionId,
          passengerId,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Unable to load payment ${booking.paymentTransactionId} for booking ${booking.id}: ${message}`,
        );
      }
    }

    return this.paymentsService.findLatestTransactionForRelatedEntity(
      this.BOOKING_RELATED_ENTITY_TYPE,
      booking.id,
      passengerId,
    );
  }

  private async findReusablePaymentForBooking(
    booking: Booking,
    passengerId: string,
    paymentMethod?: PaymentMethod,
  ): Promise<PaymentTransaction | null> {
    const payment = await this.findCurrentPaymentForBooking(
      booking,
      passengerId,
    );

    if (!payment) {
      return null;
    }

    if (paymentMethod && payment.method !== paymentMethod) {
      return null;
    }

    return [PaymentStatus.PENDING, PaymentStatus.INITIATED].includes(
      payment.status,
    )
      ? payment
      : null;
  }

  private async findBookingForPayment(
    payment: PaymentTransaction,
    passengerId?: string,
  ): Promise<Booking> {
    if (
      payment.purpose !== PaymentPurpose.TRIP_BOOKING ||
      payment.relatedEntityType !== this.BOOKING_RELATED_ENTITY_TYPE
    ) {
      throw new BadRequestException(
        'Cette transaction ne correspond pas a une reservation de trajet',
      );
    }

    const withPassenger = <T extends Record<string, unknown>>(where: T) =>
      passengerId ? { ...where, passengerId } : where;
    const where = [
      withPassenger({ paymentTransactionId: payment.id }),
      withPassenger({ paymentReference: payment.reference }),
      ...(payment.relatedEntityId
        ? [withPassenger({ id: payment.relatedEntityId })]
        : []),
    ];

    let booking = await this.bookingRepository.findOne({
      where,
      relations: ['trip', 'passenger'],
      order: { createdAt: 'DESC' },
    });

    if (!booking) {
      throw new NotFoundException('Reservation liee au paiement introuvable');
    }

    return booking;
  }

  private async applyPaymentToBooking(
    booking: Booking,
    payment: PaymentTransaction,
  ): Promise<Booking> {
    const wasAlreadyPaid =
      booking.paymentStatus === BookingPaymentStatus.SUCCEEDED;

    booking.paymentMode = TripPaymentMode.ELECTRONIC;
    booking.paymentReference = payment.reference;
    booking.paymentTransactionId = payment.id;
    booking.paymentAmount = Number(
      payment.amount ?? booking.paymentAmount ?? 0,
    );
    booking.paymentCurrency =
      payment.currency ||
      booking.paymentCurrency ||
      this.getTripPaymentCurrency();
    booking.paymentStatus = this.mapPaymentStatus(payment.status);

    if (payment.status === PaymentStatus.SUCCEEDED) {
      booking.paidAt = payment.paidAt ?? booking.paidAt ?? new Date();
    }

    const savedBooking = await this.bookingRepository.save(booking);
    await this.invalidateBookingCaches(savedBooking);

    if (
      !wasAlreadyPaid &&
      savedBooking.status === BookingStatus.COMPLETED &&
      savedBooking.paymentStatus === BookingPaymentStatus.SUCCEEDED
    ) {
      await this.finalizeCompletedBooking(savedBooking);
    }

    return savedBooking;
  }

  private mapPaymentStatus(status: PaymentStatus): BookingPaymentStatus {
    switch (status) {
      case PaymentStatus.SUCCEEDED:
        return BookingPaymentStatus.SUCCEEDED;
      case PaymentStatus.FAILED:
        return BookingPaymentStatus.FAILED;
      case PaymentStatus.CANCELLED:
        return BookingPaymentStatus.CANCELLED;
      case PaymentStatus.INITIATED:
        return BookingPaymentStatus.INITIATED;
      case PaymentStatus.PENDING:
      default:
        return BookingPaymentStatus.PENDING;
    }
  }

  private buildPaymentResponse(
    booking: Booking,
    payment: PaymentTransaction | null,
  ): BookingPaymentResponse {
    return {
      booking,
      payment: {
        transactionId: payment?.id ?? booking.paymentTransactionId,
        method: payment?.method ?? null,
        reference: payment?.reference ?? booking.paymentReference,
        orderNumber: payment?.orderNumber ?? null,
        status: payment?.status ?? null,
        statusCode: payment?.providerStatusCode ?? null,
        message: payment
          ? this.paymentsService.getClientPaymentMessage(payment)
          : this.getBookingPaymentMessage(booking),
        paymentUrl: payment?.paymentUrl ?? null,
        amount: Number(payment?.amount ?? booking.paymentAmount ?? 0),
        currency: payment?.currency ?? booking.paymentCurrency,
      },
    };
  }

  private buildCallbackResponse(
    booking: Booking,
    payment: PaymentTransaction,
    verified: boolean,
  ): BookingFlexPayCallbackResponse {
    return {
      received: true,
      verified,
      bookingId: booking.id,
      bookingPaymentStatus: booking.paymentStatus,
      paymentTransactionId: payment.id,
      paymentStatus: payment.status,
      paymentStatusCode: payment.providerStatusCode,
      message: this.paymentsService.getClientPaymentMessage(payment),
    };
  }

  private logBookingPaymentResponse(
    step: string,
    response: BookingPaymentResponse,
  ): void {
    this.logger.log(
      `${step}: response=${this.paymentsService.formatLogPayload({
        bookingId: response.booking.id,
        bookingStatus: response.booking.status,
        bookingPaymentStatus: response.booking.paymentStatus,
        payment: response.payment,
      })}`,
    );
  }

  private getBookingPaymentMessage(booking: Booking): string | null {
    switch (booking.paymentStatus) {
      case BookingPaymentStatus.NOT_REQUIRED:
        return 'Aucun paiement requis pour ce trajet';
      case BookingPaymentStatus.SUCCEEDED:
        return 'Paiement confirme avec succes';
      case BookingPaymentStatus.FAILED:
        return 'Le paiement a echoue';
      case BookingPaymentStatus.CANCELLED:
        return 'Le paiement a ete annule';
      case BookingPaymentStatus.INITIATED:
        return 'Paiement initialise. Verification en cours';
      case BookingPaymentStatus.PENDING:
      default:
        return 'Paiement en attente de confirmation';
    }
  }

  private buildTripPaymentDescription(booking: Booking): string {
    return `Paiement trajet ${booking.trip.departureLocation} vers ${booking.trip.arrivalLocation} (${booking.numberOfSeats} place(s))`;
  }

  private getBookingFlexPayCallbackUrl(): string {
    const explicitUrl =
      this.configService.get<string>('FLEXPAY_BOOKING_CALLBACK_URL')?.trim() ||
      this.configService.get<string>('FLEXPAY_TRIP_CALLBACK_URL')?.trim();
    if (explicitUrl) {
      return explicitUrl;
    }

    const configuredBaseUrl =
      this.configService.get<string>('FLEXPAY_CALLBACK_BASE_URL')?.trim() ||
      this.configService.get<string>('PUBLIC_API_BASE_URL')?.trim();

    if (configuredBaseUrl) {
      return this.joinUrl(configuredBaseUrl, 'bookings/flexpay/callback');
    }

    const port = this.configService.get<string | number>('PORT') || 5200;
    const configuredHost =
      this.configService.get<string>('HOST')?.trim() || 'localhost';
    const host = configuredHost === '0.0.0.0' ? 'localhost' : configuredHost;
    const apiPrefix =
      this.configService.get<string>('API_PREFIX')?.trim() || 'api/v1';

    return this.joinUrl(
      `http://${host}:${port}`,
      apiPrefix,
      'bookings/flexpay/callback',
    );
  }

  private joinUrl(...parts: string[]): string {
    return parts
      .map((part, index) =>
        index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, ''),
      )
      .filter(Boolean)
      .join('/');
  }

  private async invalidateBookingCaches(booking: Booking): Promise<void> {
    await this.cacheService.del(CacheService.getBookingKey(booking.id));
    await this.cacheService.del(
      CacheService.getBookingsByPassengerKey(booking.passengerId),
    );
    await this.cacheService.del(
      CacheService.getBookingsByTripKey(booking.tripId),
    );
    await this.cacheService.del(CacheService.getTripKey(booking.tripId));
  }

  private async notifyPassengerOfStatusChange(
    booking: Booking,
    status: BookingStatus,
    rejectionReason?: string,
  ) {
    try {
      const passenger = await this.userRepository.findOne({
        where: { id: booking.passengerId },
      });
      if (!passenger?.fcmToken) {
        this.logger.debug(
          `Passenger ${booking.passengerId} has no FCM token, skipping status notification`,
        );
        return;
      }

      const trip = await this.tripRepository.findOne({
        where: { id: booking.tripId },
      });

      const statusLabel =
        booking.status === BookingStatus.ACCEPTED
          ? 'acceptée'
          : booking.status === BookingStatus.REJECTED
            ? 'refusée'
            : booking.status === BookingStatus.CANCELLED
              ? 'annulée'
              : booking.status;

      let body = `Votre réservation pour ${trip?.departureLocation ?? '...'} → ${trip?.arrivalLocation ?? '...'} a été ${statusLabel}.`;

      if (
        booking.status === BookingStatus.REJECTED &&
        booking.rejectionReason
      ) {
        body += ` Motif: ${booking.rejectionReason}`;
      }

      await this.notificationService.sendNotification(
        passenger.fcmToken,
        'Mise à jour de votre réservation',
        body,
        {
          bookingId: booking.id,
          tripId: booking.tripId,
          status: booking.status,
        },
        booking.passengerId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send passenger notification: ${error.message}`,
        error.stack,
      );
    }
  }

  private async notifyDriverOfNewBooking(
    trip: Trip,
    passengerId: string,
    booking: Booking,
  ) {
    try {
      const driver =
        trip.driver ??
        (await this.userRepository.findOne({ where: { id: trip.driverId } }));

      if (!driver?.fcmToken) {
        this.logger.debug(
          `Driver ${trip.driverId} has no FCM token, skipping notification`,
        );
        return;
      }

      const passenger = await this.userRepository.findOne({
        where: { id: passengerId },
      });
      const passengerName = passenger
        ? `${passenger.firstName} ${passenger.lastName}`
        : 'Un passager';

      // Build destination message
      const destination = booking.passengerDestination || trip.arrivalLocation;
      const destinationMessage =
        booking.passengerDestination &&
        booking.passengerDestination !== trip.arrivalLocation
          ? `${trip.departureLocation} → ${destination} (destination personnalisée)`
          : `${trip.departureLocation} → ${trip.arrivalLocation}`;

      await this.notificationService.sendNotification(
        driver.fcmToken,
        'Nouvelle réservation',
        `${passengerName} a réservé ${booking.numberOfSeats} place(s) sur votre trajet ${destinationMessage}`,
        {
          bookingId: booking.id,
          tripId: trip.id,
          passengerDestination: destination,
          role: 'driver',
          driverId: trip.driverId,
        },
        trip.driverId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send booking notification: ${error.message}`,
        error.stack,
      );
    }
  }

  async confirmPickup(bookingId: string, driverId: string): Promise<Booking> {
    this.logger.log(
      `Driver ${driverId} confirming pickup for booking ${bookingId}`,
    );

    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Réservation non trouvée');
    }

    if (booking.trip.driverId !== driverId) {
      throw new ForbiddenException(
        "Vous n'êtes pas le conducteur de ce trajet",
      );
    }

    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException(
        'La réservation doit être acceptée avant de confirmer la prise en charge',
      );
    }

    if (booking.pickedUp && booking.pickedUpConfirmedByPassenger) {
      throw new BadRequestException(
        'Le passager est déjà marqué comme pris en charge',
      );
    }

    const now = new Date();
    const wasPickedUp = booking.pickedUp;
    booking.pickedUp = true;
    booking.pickedUpAt = booking.pickedUpAt ?? now;
    booking.pickedUpConfirmedByPassenger = true;
    booking.pickedUpConfirmedAt = booking.pickedUpConfirmedAt ?? now;
    booking.pickupDetectionMethod =
      booking.pickupDetectionMethod ?? 'manual_passenger_recovery';
    await this.bookingRepository.save(booking);
    await this.touchTripInteraction(booking.tripId);

    if (!wasPickedUp) {
      await this.notifySelectedEmergencyContacts(booking, 'pickup');
      await this.notifyDriverEmergencyContactsOnPickup(booking);
    }

    // Notify passenger
    await this.notifyPassengerAboutPickupConfirmation(booking);

    // Invalidate cache
    await this.cacheService.del(
      CacheService.getBookingsByTripKey(booking.tripId),
    );
    await this.cacheService.del(
      CacheService.getBookingsByPassengerKey(booking.passengerId),
    );

    this.logger.log(`Pickup confirmed for booking ${bookingId}`);
    return booking;
  }

  async confirmPickupByPassenger(
    bookingId: string,
    passengerId: string,
  ): Promise<Booking> {
    this.logger.log(
      `Passenger ${passengerId} confirming pickup for booking ${bookingId}`,
    );

    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Réservation non trouvée');
    }

    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException(
        'La reservation doit etre acceptee avant de confirmer la prise en charge',
      );
    }

    if (booking.pickedUp && booking.pickedUpConfirmedByPassenger) {
      throw new BadRequestException(
        'La prise en charge est déjà confirmée par le passager',
      );
    }

    const now = new Date();
    const wasPickedUp = booking.pickedUp;
    booking.pickedUp = true;
    booking.pickedUpAt = booking.pickedUpAt ?? now;
    booking.pickedUpConfirmedByPassenger = true;
    booking.pickedUpConfirmedAt = booking.pickedUpConfirmedAt ?? now;
    await this.bookingRepository.save(booking);
    await this.touchTripInteraction(booking.tripId);

    if (!wasPickedUp) {
      await this.notifySelectedEmergencyContacts(booking, 'pickup');
      await this.notifyDriverEmergencyContactsOnPickup(booking);
    }

    // Notify driver
    await this.notifyDriverAboutPickupConfirmation(booking);

    // Invalidate cache
    await this.cacheService.del(
      CacheService.getBookingsByTripKey(booking.tripId),
    );
    await this.cacheService.del(
      CacheService.getBookingsByPassengerKey(booking.passengerId),
    );

    this.logger.log(`Pickup confirmed by passenger for booking ${bookingId}`);
    return booking;
  }

  async confirmDropoff(bookingId: string, driverId: string): Promise<Booking> {
    this.logger.log(
      `Driver ${driverId} confirming dropoff for booking ${bookingId}`,
    );

    let booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Réservation non trouvée');
    }

    if (booking.trip.driverId !== driverId) {
      throw new ForbiddenException(
        "Vous n'êtes pas le conducteur de ce trajet",
      );
    }

    if (!this.hasBookingBeenPickedUpForRideProgress(booking)) {
      throw new BadRequestException(
        'La prise en charge du passager doit être confirmée avant son arrivée',
      );
    }

    if (booking.droppedOff && booking.status === BookingStatus.COMPLETED) {
      throw new BadRequestException("L'arrivée est déjà confirmée");
    }

    const now = new Date();
    booking.pickedUp = true;
    booking.pickedUpAt = booking.pickedUpAt ?? now;
    booking.pickedUpConfirmedByPassenger = true;
    booking.pickedUpConfirmedAt = booking.pickedUpConfirmedAt ?? now;
    booking.droppedOffConfirmedByPassenger = true;
    booking.droppedOffConfirmedAt = booking.droppedOffConfirmedAt ?? now;
    booking.droppedOff = true;
    booking.droppedOffAt = booking.droppedOffAt ?? now;
    booking.dropoffDetectionMethod =
      booking.dropoffDetectionMethod ?? 'manual_driver_recovery';
    booking.status = BookingStatus.COMPLETED;

    await this.bookingRepository.save(booking);
    booking = await this.settlePaymentAfterArrival(booking);
    await this.touchTripInteraction(booking.tripId);

    await this.notifySelectedEmergencyContacts(booking, 'dropoff');

    // Notify passenger
    await this.notifyPassengerAboutDropoffConfirmation(booking);

    // Invalidate cache
    await this.cacheService.del(
      CacheService.getBookingsByTripKey(booking.tripId),
    );
    await this.cacheService.del(
      CacheService.getBookingsByPassengerKey(booking.passengerId),
    );

    this.logger.log(`Dropoff confirmed by driver for booking ${bookingId}`);
    return booking;
  }

  async confirmDropoffByPassenger(
    bookingId: string,
    passengerId: string,
    dto?: ConfirmDropoffDto,
  ): Promise<Booking> {
    this.logger.log(
      `Passenger ${passengerId} requesting dropoff for booking ${bookingId}`,
    );

    let booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Réservation non trouvée');
    }

    if (!this.hasBookingBeenPickedUpForRideProgress(booking)) {
      throw new BadRequestException(
        'La prise en charge du passager doit être confirmée avant de signaler son arrivée',
      );
    }

    if (booking.droppedOff && booking.status === BookingStatus.COMPLETED) {
      throw new BadRequestException(
        "L'arrivée a déjà été signalée au conducteur",
      );
    }

    if (dto?.paymentMode && dto.paymentMode !== booking.paymentMode) {
      booking = await this.updatePaymentMode(
        booking.id,
        passengerId,
        dto.paymentMode,
      );
    }

    const now = new Date();
    booking.pickedUp = true;
    booking.pickedUpAt = booking.pickedUpAt ?? now;
    booking.pickedUpConfirmedByPassenger = true;
    booking.pickedUpConfirmedAt = booking.pickedUpConfirmedAt ?? now;
    booking.droppedOffConfirmedByPassenger = true;
    booking.droppedOffConfirmedAt = booking.droppedOffConfirmedAt ?? now;
    booking.droppedOff = true;
    booking.droppedOffAt = booking.droppedOffAt ?? now;
    booking.dropoffDetectionMethod =
      booking.dropoffDetectionMethod ?? 'manual_passenger_recovery';
    booking.status = BookingStatus.COMPLETED;

    await this.bookingRepository.save(booking);
    booking = await this.settlePaymentAfterArrival(booking);
    await this.touchTripInteraction(booking.tripId);
    await this.notifySelectedEmergencyContacts(booking, 'dropoff');

    // Notify driver
    await this.notifyDriverAboutDropoffConfirmation(booking);
    await this.notifyPassengerAboutDropoffConfirmation(booking);

    // Invalidate cache
    await this.cacheService.del(
      CacheService.getBookingsByTripKey(booking.tripId),
    );
    await this.cacheService.del(
      CacheService.getBookingsByPassengerKey(booking.passengerId),
    );

    this.logger.log(`Dropoff requested by passenger for booking ${bookingId}`);
    return booking;
  }

  private buildPickupAwarenessEvent(
    type: 'driver_near_pickup' | 'driver_arrived_pickup' | 'parties_nearby',
    booking: Booking,
    distanceMeters: number,
    now: Date,
  ): AutomaticRideProgressEvent {
    const event: AutomaticRideProgressEvent = {
      type,
      bookingId: booking.id,
      tripId: booking.tripId,
      passengerId: booking.passengerId,
      distanceMeters: Math.round(distanceMeters),
      detectedAt: now.toISOString(),
    };

    if (type === 'driver_arrived_pickup') {
      event.expiresAt = new Date(
        now.getTime() + this.PICKUP_WAIT_WINDOW_MS,
      ).toISOString();
      event.pickupWaitSeconds = Math.round(this.PICKUP_WAIT_WINDOW_MS / 1000);
    }

    return event;
  }

  private detectPickupAwarenessEvents(
    booking: Booking,
  ): AutomaticRideProgressEvent[] {
    if (
      !this.canEvaluateAutomaticProgress(booking) ||
      booking.pickedUp ||
      booking.pickedUpConfirmedByPassenger
    ) {
      return [];
    }

    const now = new Date();
    const events: AutomaticRideProgressEvent[] = [];
    const pickupPoint = this.getPickupPoint(booking);

    if (
      pickupPoint &&
      booking.trip?.currentLocation &&
      this.isFreshLocationUpdate(booking.trip.lastLocationUpdateAt, now)
    ) {
      const driverDistanceToPickup = this.calculatePointDistanceMeters(
        booking.trip.currentLocation,
        pickupPoint,
      );

      if (
        driverDistanceToPickup !== null &&
        driverDistanceToPickup <=
          this.AUTO_PICKUP_DRIVER_ARRIVAL_THRESHOLD_METERS
      ) {
        events.push(
          this.buildPickupAwarenessEvent(
            'driver_arrived_pickup',
            booking,
            driverDistanceToPickup,
            now,
          ),
        );
      } else if (
        driverDistanceToPickup !== null &&
        driverDistanceToPickup <= this.AUTO_PICKUP_DRIVER_NEAR_THRESHOLD_METERS
      ) {
        events.push(
          this.buildPickupAwarenessEvent(
            'driver_near_pickup',
            booking,
            driverDistanceToPickup,
            now,
          ),
        );
      }
    }

    if (this.hasFreshGpsPair(booking, now)) {
      const phoneDistance = this.calculatePointDistanceMeters(
        booking.trip.currentLocation,
        booking.passengerCurrentLocation,
      );
      const passengerDistanceToPickup = pickupPoint
        ? this.calculatePointDistanceMeters(
            booking.passengerCurrentLocation,
            pickupPoint,
          )
        : null;
      const nearestReadyDistance = Math.min(
        phoneDistance ?? Number.POSITIVE_INFINITY,
        passengerDistanceToPickup ?? Number.POSITIVE_INFINITY,
      );

      if (
        Number.isFinite(nearestReadyDistance) &&
        nearestReadyDistance <=
          this.AUTO_PICKUP_PASSENGER_READY_THRESHOLD_METERS
      ) {
        events.push(
          this.buildPickupAwarenessEvent(
            'parties_nearby',
            booking,
            nearestReadyDistance,
            now,
          ),
        );
      }
    }

    return events;
  }

  private async detectPassengerDestinationAwarenessEvent(
    booking: Booking,
  ): Promise<AutomaticRideProgressEvent | null> {
    if (
      !this.canEvaluateAutomaticProgress(booking) ||
      !this.hasBookingBeenPickedUpForRideProgress(booking) ||
      this.hasBookingBeenDroppedOffForTripEnd(booking) ||
      booking.passengerDestinationApproachNotifiedAt
    ) {
      return null;
    }

    const now = new Date();
    if (
      !booking.trip?.currentLocation ||
      !this.isFreshLocationUpdate(booking.trip.lastLocationUpdateAt, now)
    ) {
      return null;
    }

    const dropoffPoint = this.getDropoffPoint(booking);
    const driverDistanceToDestination = this.calculatePointDistanceMeters(
      booking.trip.currentLocation,
      dropoffPoint,
    );
    if (
      driverDistanceToDestination === null ||
      driverDistanceToDestination >
        this.PASSENGER_DESTINATION_NOTICE_THRESHOLD_METERS
    ) {
      return null;
    }

    booking.passengerDestinationApproachNotifiedAt = now;
    const savedBooking = await this.bookingRepository.save(booking);

    return {
      type: 'passenger_near_destination',
      bookingId: savedBooking.id,
      tripId: savedBooking.tripId,
      passengerId: savedBooking.passengerId,
      distanceMeters: Math.round(driverDistanceToDestination),
      detectedAt: now.toISOString(),
    };
  }

  async buildPassengerPickupSignal(
    passengerId: string,
    bookingId: string,
  ): Promise<AutomaticRideProgressEvent> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
      relations: ['trip'],
    });

    if (!booking) {
      throw new NotFoundException(
        "Reservation non trouvee ou vous n'etes pas le passager",
      );
    }

    if (!this.canEvaluateAutomaticProgress(booking)) {
      throw new BadRequestException(
        'Le trajet doit etre actif et la reservation acceptee pour vous signaler',
      );
    }

    if (booking.pickedUp || booking.pickedUpConfirmedByPassenger) {
      throw new BadRequestException('La prise en charge est deja confirmee');
    }

    return {
      type: 'passenger_ready_pickup',
      bookingId: booking.id,
      tripId: booking.tripId,
      passengerId: booking.passengerId,
      detectedAt: new Date().toISOString(),
    };
  }

  async evaluateAutomaticRideProgressForTrip(
    tripId: string,
  ): Promise<AutomaticRideProgressResult> {
    return this.runAutomaticRideProgressSerially(tripId, () =>
      this.evaluateAutomaticRideProgressForTripUnlocked(tripId),
    );
  }

  private async runAutomaticRideProgressSerially<T>(
    tripId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.automaticRideProgressQueues.get(tripId);
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queueTail = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => current);
    this.automaticRideProgressQueues.set(tripId, queueTail);

    await previous?.catch(() => undefined);
    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (this.automaticRideProgressQueues.get(tripId) === queueTail) {
        this.automaticRideProgressQueues.delete(tripId);
      }
    }
  }

  private async evaluateAutomaticRideProgressForTripUnlocked(
    tripId: string,
  ): Promise<AutomaticRideProgressResult> {
    const result: AutomaticRideProgressResult = { tripId, events: [] };
    const bookings = await this.bookingRepository.find({
      where: { tripId },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    for (const booking of bookings) {
      result.events.push(...this.detectPickupAwarenessEvents(booking));

      const pickupEvent = await this.tryConfirmAutomaticPickup(booking);
      if (pickupEvent) {
        result.events.push(pickupEvent);
        continue;
      }

      const noShowEvent = await this.tryConfirmAutomaticNoShow(booking);
      if (noShowEvent) {
        result.events.push(noShowEvent);
        continue;
      }

      const destinationAwarenessEvent =
        await this.detectPassengerDestinationAwarenessEvent(booking);
      if (destinationAwarenessEvent) {
        result.events.push(destinationAwarenessEvent);
      }

      const dropoffEvent = await this.tryConfirmAutomaticDropoff(booking);
      if (dropoffEvent) {
        result.events.push(dropoffEvent);
      }
    }

    const tripDestinationEvent = await this.tryCompleteTripAtDestination(
      tripId,
      bookings,
    );
    result.events.push(...tripDestinationEvent);

    if (result.events.length > 0) {
      this.logger.log(
        `Automatic ride progress updated for trip ${tripId}: ${result.events
          .map((event) => `${event.type}:${event.bookingId ?? event.tripId}`)
          .join(', ')}`,
      );
    }

    return result;
  }

  private hasFreshGpsPair(booking: Booking, now = new Date()): boolean {
    return (
      Boolean(booking.trip?.currentLocation) &&
      Boolean(booking.passengerCurrentLocation) &&
      this.isFreshLocationUpdate(booking.trip?.lastLocationUpdateAt, now) &&
      this.isFreshLocationUpdate(booking.passengerLastLocationUpdateAt, now)
    );
  }

  private getPickupPoint(booking: Booking): Point | null {
    return booking.passengerOriginPoint ?? booking.trip?.departurePoint ?? null;
  }

  private getDropoffPoint(booking: Booking): Point | null {
    return (
      booking.passengerDestinationPoint ?? booking.trip?.arrivalPoint ?? null
    );
  }

  private hasBookingBeenPickedUpForRideProgress(booking: Booking): boolean {
    return Boolean(
      booking.pickedUp ||
      booking.pickedUpConfirmedByPassenger ||
      booking.pickedUpAt ||
      booking.pickedUpConfirmedAt,
    );
  }

  private hasBookingBeenDroppedOffForTripEnd(booking: Booking): boolean {
    return Boolean(
      booking.status === BookingStatus.COMPLETED ||
      booking.droppedOff ||
      booking.droppedOffConfirmedByPassenger ||
      booking.droppedOffAt ||
      booking.droppedOffConfirmedAt,
    );
  }

  private async tryCompleteTripAtDestination(
    tripId: string,
    bookings: Booking[],
  ): Promise<AutomaticRideProgressEvent[]> {
    const trip =
      bookings.find((booking) => booking.trip)?.trip ??
      (await this.tripRepository.findOne({ where: { id: tripId } }));
    if (
      !trip ||
      trip.status !== TripStatus.ACTIVE ||
      !trip.currentLocation ||
      !trip.arrivalPoint
    ) {
      return [];
    }

    const now = new Date();
    if (!this.isFreshLocationUpdate(trip.lastLocationUpdateAt, now)) {
      return [];
    }

    const driverDistanceToDestination = this.calculatePointDistanceMeters(
      trip.currentLocation,
      trip.arrivalPoint,
    );
    if (driverDistanceToDestination === null) {
      return [];
    }

    if (
      driverDistanceToDestination >
      this.AUTO_TRIP_DESTINATION_NOTICE_THRESHOLD_METERS
    ) {
      const reachedAt = trip.destinationReachedAt
        ? new Date(trip.destinationReachedAt).getTime()
        : null;
      const passedDestinationAfterReaching =
        reachedAt !== null &&
        driverDistanceToDestination >
          this.AUTO_TRIP_DESTINATION_REACHED_THRESHOLD_METERS +
            this.AUTO_TRIP_DESTINATION_PASSED_GRACE_METERS;
      const stayedReachedLongEnough =
        reachedAt !== null &&
        Number.isFinite(reachedAt) &&
        now.getTime() - reachedAt >=
          this.AUTO_TRIP_DESTINATION_COMPLETION_DELAY_MS;

      if (!passedDestinationAfterReaching && !stayedReachedLongEnough) {
        return [];
      }

      const bookingEvents = await this.resolveBookingsAtTripDestination(
        bookings,
        trip,
        now,
      );
      if (await this.hasUnresolvedAcceptedBookings(trip.id)) {
        return bookingEvents;
      }
      if (
        await this.hasPendingAutomaticBoardingCandidate(bookings, trip, now)
      ) {
        return bookingEvents;
      }
      const completionResult = await this.tripRepository.update(
        { id: trip.id, status: TripStatus.ACTIVE },
        {
          status: TripStatus.COMPLETED,
          completedAt: trip.completedAt ?? now,
        },
      );
      if (completionResult.affected !== 1) {
        return bookingEvents;
      }
      trip.status = TripStatus.COMPLETED;
      trip.completedAt = trip.completedAt ?? now;
      await this.tripRepository.save(trip);
      await this.cacheService.del(CacheService.getTripKey(trip.id));
      await this.cacheService.del(CacheService.getTripsListKey());
      await this.cacheService.del(CacheService.getTripsListKey('all'));

      return [
        ...bookingEvents,
        {
          type: 'driver_arrived_destination',
          tripId: trip.id,
          distanceMeters: Math.round(driverDistanceToDestination),
          detectedAt: now.toISOString(),
        },
      ];
    }

    const shouldNotifyArrival =
      !trip.destinationApproachNotifiedAt &&
      driverDistanceToDestination <=
        this.AUTO_TRIP_DESTINATION_NOTICE_THRESHOLD_METERS;
    const hasReachedDestination =
      driverDistanceToDestination <=
      this.AUTO_TRIP_DESTINATION_REACHED_THRESHOLD_METERS;

    if (hasReachedDestination) {
      const bookingEvents = await this.resolveBookingsAtTripDestination(
        bookings,
        trip,
        now,
      );
      if (await this.hasUnresolvedAcceptedBookings(trip.id)) {
        return bookingEvents;
      }
      if (
        await this.hasPendingAutomaticBoardingCandidate(bookings, trip, now)
      ) {
        return bookingEvents;
      }
      const destinationApproachNotifiedAt =
        trip.destinationApproachNotifiedAt ?? now;
      const destinationReachedAt = trip.destinationReachedAt ?? now;
      const completedAt = trip.completedAt ?? now;
      const completionResult = await this.tripRepository.update(
        { id: trip.id, status: TripStatus.ACTIVE },
        {
          destinationApproachNotifiedAt,
          destinationReachedAt,
          status: TripStatus.COMPLETED,
          completedAt,
        },
      );
      if (completionResult.affected !== 1) {
        return bookingEvents;
      }
      trip.destinationApproachNotifiedAt = destinationApproachNotifiedAt;
      trip.destinationReachedAt = destinationReachedAt;
      trip.status = TripStatus.COMPLETED;
      trip.completedAt = completedAt;
      await this.tripRepository.save(trip);
      await this.cacheService.del(CacheService.getTripKey(trip.id));
      await this.cacheService.del(CacheService.getTripsListKey());
      await this.cacheService.del(CacheService.getTripsListKey('all'));

      return [
        ...bookingEvents,
        {
          type: 'driver_arrived_destination',
          tripId: trip.id,
          distanceMeters: Math.round(driverDistanceToDestination),
          detectedAt: now.toISOString(),
        },
      ];
    }

    if (!shouldNotifyArrival) {
      return [];
    }

    trip.destinationApproachNotifiedAt = now;
    await this.tripRepository.save(trip);

    return [
      {
        type: 'driver_near_destination',
        tripId: trip.id,
        distanceMeters: Math.round(driverDistanceToDestination),
        detectedAt: now.toISOString(),
      },
    ];
  }

  private async resolveBookingsAtTripDestination(
    bookings: Booking[],
    trip: Trip,
    now: Date,
  ): Promise<AutomaticRideProgressEvent[]> {
    const events: AutomaticRideProgressEvent[] = [];

    for (const booking of bookings) {
      if (
        booking.status !== BookingStatus.ACCEPTED ||
        this.hasBookingBeenDroppedOffForTripEnd(booking)
      ) {
        continue;
      }

      if (this.hasBookingBeenPickedUpForRideProgress(booking)) {
        const dropoffEvent = await this.completeAutomaticDropoff(
          booking,
          now,
          'automatic_trip_destination',
        );
        if (dropoffEvent) {
          events.push(dropoffEvent);
        }
        continue;
      }

      const uncertainEvent = await this.markAutomaticBoardingUncertain(
        booking,
        trip,
        now,
      );
      if (uncertainEvent) {
        events.push(uncertainEvent);
      }
    }

    return events;
  }

  private async markAutomaticBoardingUncertain(
    booking: Booking,
    trip: Trip,
    now: Date,
  ): Promise<AutomaticRideProgressEvent | null> {
    if (
      booking.status !== BookingStatus.ACCEPTED ||
      this.hasBookingBeenPickedUpForRideProgress(booking)
    ) {
      return null;
    }

    if (await this.hasActiveBoardingCandidate(booking, trip, now)) {
      return null;
    }

    const driverDistanceFromPickup = this.calculatePointDistanceMeters(
      trip.currentLocation,
      this.getPickupPoint(booking),
    );
    const boardingUncertainReason =
      'trip_destination_reached_without_boarding_evidence';
    const boardingUncertainDriverDistanceMeters =
      driverDistanceFromPickup === null
        ? null
        : Math.round(driverDistanceFromPickup);
    const rejectionReason =
      'Embarquement impossible a confirmer automatiquement avant la fin du trajet';
    const preservesSucceededPayment =
      booking.paymentStatus === BookingPaymentStatus.SUCCEEDED;
    if (preservesSucceededPayment) {
      this.logger.error(
        `Uncertain boarding ${booking.id} already has a succeeded payment; manual financial review required`,
      );
    }

    const updateResult = await this.bookingRepository.update(
      {
        id: booking.id,
        status: BookingStatus.ACCEPTED,
        pickedUp: false,
        passengerLastLocationUpdateAt: booking.passengerLastLocationUpdateAt
          ? Equal(booking.passengerLastLocationUpdateAt)
          : IsNull(),
      },
      {
        status: BookingStatus.BOARDING_UNCERTAIN,
        boardingUncertainDetectedAt: now,
        boardingUncertainReason,
        boardingUncertainDriverDistanceMeters,
        rejectionReason,
        ...(!preservesSucceededPayment
          ? {
              paymentStatus: BookingPaymentStatus.CANCELLED,
              paidAt: null,
              paymentReference: null,
              paymentTransactionId: null,
            }
          : {}),
      },
    );
    if (updateResult.affected !== 1) {
      return null;
    }

    booking.status = BookingStatus.BOARDING_UNCERTAIN;
    booking.boardingUncertainDetectedAt = now;
    booking.boardingUncertainReason = boardingUncertainReason;
    booking.boardingUncertainDriverDistanceMeters =
      boardingUncertainDriverDistanceMeters;
    booking.rejectionReason = rejectionReason;
    if (!preservesSucceededPayment) {
      booking.paymentStatus = BookingPaymentStatus.CANCELLED;
      booking.paidAt = null;
      booking.paymentReference = null;
      booking.paymentTransactionId = null;
    }

    const savedBooking = booking;
    await this.recalculateAvailableSeatsForTrip(savedBooking.tripId);
    await this.touchTripInteraction(savedBooking.tripId);
    await this.notifyPassengerAboutAutomaticBoardingUncertain(savedBooking);
    await this.invalidateBookingCaches(savedBooking);

    this.logger.warn(
      JSON.stringify({
        event: 'passenger_boarding_uncertain',
        bookingId: savedBooking.id,
        tripId: savedBooking.tripId,
        passengerId: savedBooking.passengerId,
        detectedAt: now.toISOString(),
        reason: savedBooking.boardingUncertainReason,
        paymentStatus: savedBooking.paymentStatus,
      }),
    );

    return {
      type: 'passenger_boarding_uncertain',
      bookingId: savedBooking.id,
      tripId: savedBooking.tripId,
      passengerId: savedBooking.passengerId,
      distanceMeters:
        savedBooking.boardingUncertainDriverDistanceMeters ?? undefined,
      detectedAt: now.toISOString(),
      boardingUncertainReason:
        savedBooking.boardingUncertainReason ?? undefined,
    };
  }

  private async hasPendingAutomaticBoardingCandidate(
    bookings: Booking[],
    trip: Trip,
    now: Date,
  ): Promise<boolean> {
    for (const booking of bookings) {
      if (
        ![BookingStatus.ACCEPTED, BookingStatus.NO_SHOW].includes(
          booking.status,
        ) ||
        this.hasBookingBeenPickedUpForRideProgress(booking)
      ) {
        continue;
      }
      if (await this.hasActiveBoardingCandidate(booking, trip, now)) {
        return true;
      }
    }
    return false;
  }

  private async hasUnresolvedAcceptedBookings(
    tripId: string,
  ): Promise<boolean> {
    const acceptedBookings = await this.bookingRepository.find({
      where: { tripId, status: BookingStatus.ACCEPTED },
    });
    return acceptedBookings.some(
      (booking) =>
        booking.status === BookingStatus.ACCEPTED &&
        !this.hasBookingBeenDroppedOffForTripEnd(booking),
    );
  }

  private async hasActiveBoardingCandidate(
    booking: Booking,
    trip: Trip,
    now: Date,
  ): Promise<boolean> {
    if (
      !trip.driverId ||
      !trip.currentLocation ||
      !booking.passengerCurrentLocation ||
      !this.isFreshLocationUpdate(trip.lastLocationUpdateAt, now) ||
      !this.isFreshLocationUpdate(booking.passengerLastLocationUpdateAt, now)
    ) {
      return false;
    }

    const candidate = await this.locationHistoryService.getBoardingCandidate(
      booking.tripId,
      trip.driverId,
      booking.passengerId,
    );
    if (
      !candidate ||
      [
        BoardingDetectionState.BOARDING_CONFIRMED,
        BoardingDetectionState.BOARDING_REJECTED,
        BoardingDetectionState.BOARDING_CANDIDATE_EXPIRED,
      ].includes(candidate.state)
    ) {
      return false;
    }

    const createdAt = new Date(candidate.createdAt).getTime();
    return (
      Number.isFinite(createdAt) &&
      now.getTime() - createdAt <=
        this.boardingDetectionConfig.candidateExpirationMs
    );
  }

  private canEvaluateAutomaticProgress(booking: Booking): boolean {
    return (
      booking.status === BookingStatus.ACCEPTED &&
      booking.trip?.status === TripStatus.ACTIVE
    );
  }

  private canEvaluateAutomaticPickupProgress(booking: Booking): boolean {
    return (
      [BookingStatus.ACCEPTED, BookingStatus.NO_SHOW].includes(
        booking.status,
      ) && booking.trip?.status === TripStatus.ACTIVE
    );
  }

  private async tryConfirmAutomaticPickup(
    booking: Booking,
  ): Promise<AutomaticRideProgressEvent | null> {
    if (
      !this.canEvaluateAutomaticPickupProgress(booking) ||
      (booking.pickedUp && booking.pickedUpConfirmedByPassenger)
    ) {
      return null;
    }

    const now = new Date();
    const pickupPoint = this.getPickupPoint(booking);
    const driverLocation = booking.trip?.currentLocation ?? null;
    const hasFreshDriverLocation = Boolean(
      driverLocation &&
      this.isFreshLocationUpdate(booking.trip?.lastLocationUpdateAt, now),
    );
    const driverDistanceToPickup = hasFreshDriverLocation
      ? this.calculatePointDistanceMeters(driverLocation, pickupPoint)
      : null;
    const passengerDistanceToPickup =
      booking.passengerCurrentLocation &&
      this.isFreshLocationUpdate(booking.passengerLastLocationUpdateAt, now)
        ? this.calculatePointDistanceMeters(
            booking.passengerCurrentLocation,
            pickupPoint,
          )
        : null;
    const allowCandidateAwayFromPickup = Boolean(
      this.hasFreshGpsPair(booking, now) &&
      driverDistanceToPickup !== null &&
      passengerDistanceToPickup !== null &&
      driverDistanceToPickup >
        this.boardingDetectionConfig.maximumRadiusMeters &&
      passengerDistanceToPickup >
        this.boardingDetectionConfig.maximumRadiusMeters,
    );

    if (
      driverDistanceToPickup !== null &&
      driverDistanceToPickup <=
        this.AUTO_PICKUP_DRIVER_ARRIVAL_THRESHOLD_METERS &&
      !booking.driverPickupArrivedAt
    ) {
      booking.driverPickupArrivedAt = now;
      await this.bookingRepository.save(booking);
    }

    const driverId = booking.trip?.driverId;
    if (!driverId) {
      return null;
    }

    const [driverHistory, passengerHistory, existingCandidate] =
      await Promise.all([
        this.locationHistoryService.getDriverLocationHistory(booking.tripId),
        this.locationHistoryService.getPassengerLocationHistory(booking.id),
        this.locationHistoryService.getBoardingCandidate(
          booking.tripId,
          driverId,
          booking.passengerId,
        ),
      ]);
    const candidateForDetection =
      booking.status === BookingStatus.NO_SHOW &&
      existingCandidate?.origin !== 'in_trip_recovery'
        ? null
        : existingCandidate;
    const detection = evaluateBoardingDetection({
      now,
      stateCompatible: this.canEvaluateAutomaticPickupProgress(booking),
      pickupLocation: this.pointToLatLng(pickupPoint),
      driverLocations: this.getBoardingLocationSamples(driverHistory),
      passengerLocations: this.getBoardingLocationSamples(passengerHistory),
      candidate: candidateForDetection,
      allowCandidateAwayFromPickup,
      config: this.boardingDetectionConfig,
    });
    this.logBoardingDetectionEvaluation(booking, detection.metrics);

    if (detection.decision !== 'CONFIRM') {
      if (detection.candidate) {
        await this.locationHistoryService.saveBoardingCandidate(
          booking.tripId,
          driverId,
          booking.passengerId,
          detection.candidate,
        );
      }
      return null;
    }

    const wasPickedUp = booking.pickedUp;
    const wasConfirmedByPassenger = booking.pickedUpConfirmedByPassenger;
    const recoveredFromNoShow = booking.status === BookingStatus.NO_SHOW;
    const pickedUpAt = booking.pickedUpAt ?? now;
    const detectionMethod =
      detection.candidate?.origin === 'in_trip_recovery' || recoveredFromNoShow
        ? 'automatic_shared_movement_late_recovery'
        : 'automatic_shared_movement';
    const paymentAmount = Number(booking.paymentAmount ?? 0);
    const paymentStatusAfterPickup =
      booking.paymentStatus === BookingPaymentStatus.SUCCEEDED
        ? BookingPaymentStatus.SUCCEEDED
        : paymentAmount > 0 &&
            [TripPaymentMode.ELECTRONIC, TripPaymentMode.POINTS].includes(
              booking.paymentMode,
            )
          ? BookingPaymentStatus.PENDING
          : BookingPaymentStatus.NOT_REQUIRED;
    const updateResult = await this.bookingRepository.update(
      {
        id: booking.id,
        status: In([BookingStatus.ACCEPTED, BookingStatus.NO_SHOW]),
        pickedUp: false,
      },
      {
        status: BookingStatus.ACCEPTED,
        pickedUp: true,
        pickedUpAt,
        pickupDetectionMethod: detectionMethod,
        rejectionReason: null,
        paymentStatus: paymentStatusAfterPickup,
        ...(paymentStatusAfterPickup !== BookingPaymentStatus.SUCCEEDED
          ? {
              paidAt: null,
              paymentReference: null,
              paymentTransactionId: null,
            }
          : {}),
      },
    );

    if (updateResult.affected !== 1) {
      if (detection.candidate) {
        await this.locationHistoryService.saveBoardingCandidate(
          booking.tripId,
          driverId,
          booking.passengerId,
          detection.candidate,
        );
      }
      this.logger.debug(
        `Automatic pickup already confirmed for booking ${booking.id}`,
      );
      return null;
    }

    booking.pickedUp = true;
    booking.pickedUpAt = pickedUpAt;
    booking.status = BookingStatus.ACCEPTED;
    booking.pickupDetectionMethod = detectionMethod;
    booking.rejectionReason = null;
    booking.paymentStatus = paymentStatusAfterPickup;
    if (paymentStatusAfterPickup !== BookingPaymentStatus.SUCCEEDED) {
      booking.paidAt = null;
      booking.paymentReference = null;
      booking.paymentTransactionId = null;
    }
    if (detection.candidate) {
      await this.locationHistoryService.saveBoardingCandidate(
        booking.tripId,
        driverId,
        booking.passengerId,
        detection.candidate,
      );
    }
    if (recoveredFromNoShow) {
      await this.recalculateAvailableSeatsForTrip(booking.tripId);
    }
    await this.touchTripInteraction(booking.tripId);

    if (recoveredFromNoShow) {
      this.logger.warn(
        JSON.stringify({
          event: 'passenger_no_show_recovered',
          bookingId: booking.id,
          tripId: booking.tripId,
          passengerId: booking.passengerId,
          detectedAt: now.toISOString(),
          detectionMethod,
          paymentStatus: booking.paymentStatus,
        }),
      );
    }

    if (!wasPickedUp) {
      await this.notifySelectedEmergencyContacts(booking, 'pickup');
      await this.notifyDriverEmergencyContactsOnPickup(booking);
    }

    await this.notifyPassengerAboutAutomaticPickupConfirmation(booking);
    if (!wasConfirmedByPassenger) {
      await this.notifyDriverAboutAutomaticPickupConfirmation(booking);
    }

    await this.invalidateBookingCaches(booking);

    return {
      type: 'pickup_confirmed',
      bookingId: booking.id,
      tripId: booking.tripId,
      passengerId: booking.passengerId,
      detectedAt: now.toISOString(),
      boardingState: BoardingDetectionState.BOARDING_CONFIRMED,
      confidenceScore: detection.metrics.confidenceScore,
      decision: detection.decision,
      rejectionReason: null,
      detectionMethod,
    };
  }

  private async tryConfirmAutomaticNoShow(
    booking: Booking,
  ): Promise<AutomaticRideProgressEvent | null> {
    if (
      !this.canEvaluateAutomaticProgress(booking) ||
      this.hasBookingBeenPickedUpForRideProgress(booking) ||
      !booking.driverPickupArrivedAt
    ) {
      return null;
    }

    const now = new Date();
    const arrivedAt = new Date(booking.driverPickupArrivedAt).getTime();
    if (
      !Number.isFinite(arrivedAt) ||
      now.getTime() - arrivedAt < this.PICKUP_WAIT_WINDOW_MS ||
      !booking.trip?.currentLocation ||
      !this.isFreshLocationUpdate(booking.trip.lastLocationUpdateAt, now)
    ) {
      return null;
    }

    const pickupPoint = this.getPickupPoint(booking);
    const driverDistanceFromPickup = this.calculatePointDistanceMeters(
      booking.trip.currentLocation,
      pickupPoint,
    );
    if (
      driverDistanceFromPickup === null ||
      driverDistanceFromPickup <
        this.AUTO_NO_SHOW_DRIVER_DEPARTURE_THRESHOLD_METERS
    ) {
      return null;
    }

    if (
      !booking.passengerCurrentLocation ||
      !this.isFreshLocationUpdate(booking.passengerLastLocationUpdateAt, now)
    ) {
      return null;
    }

    const passengerDistanceFromPickup = this.calculatePointDistanceMeters(
      booking.passengerCurrentLocation,
      pickupPoint,
    );
    const distanceBetweenUsers = this.calculatePointDistanceMeters(
      booking.trip.currentLocation,
      booking.passengerCurrentLocation,
    );
    if (
      passengerDistanceFromPickup === null ||
      passengerDistanceFromPickup >
        this.boardingDetectionConfig.maximumRadiusMeters ||
      distanceBetweenUsers === null ||
      distanceBetweenUsers <= this.boardingDetectionConfig.maximumRadiusMeters
    ) {
      return null;
    }

    const noShowReason = 'automatic_non_boarding';
    const noShowDriverDistanceMeters = Math.round(driverDistanceFromPickup);
    const rejectionReason = 'Passager non embarque detecte automatiquement';
    const preservesSucceededPayment =
      booking.paymentStatus === BookingPaymentStatus.SUCCEEDED;
    if (preservesSucceededPayment) {
      this.logger.error(
        `No-show booking ${booking.id} already has a succeeded payment; manual financial review required`,
      );
    }

    const updateResult = await this.bookingRepository.update(
      {
        id: booking.id,
        status: BookingStatus.ACCEPTED,
        pickedUp: false,
        passengerLastLocationUpdateAt: booking.passengerLastLocationUpdateAt
          ? Equal(booking.passengerLastLocationUpdateAt)
          : IsNull(),
      },
      {
        status: BookingStatus.NO_SHOW,
        noShowDetectedAt: now,
        noShowReason,
        noShowDriverDistanceMeters,
        rejectionReason,
        ...(!preservesSucceededPayment
          ? {
              paymentStatus: BookingPaymentStatus.CANCELLED,
              paidAt: null,
              paymentReference: null,
              paymentTransactionId: null,
            }
          : {}),
      },
    );
    if (updateResult.affected !== 1) {
      return null;
    }

    booking.status = BookingStatus.NO_SHOW;
    booking.noShowDetectedAt = now;
    booking.noShowReason = noShowReason;
    booking.noShowDriverDistanceMeters = noShowDriverDistanceMeters;
    booking.rejectionReason = rejectionReason;
    if (!preservesSucceededPayment) {
      booking.paymentStatus = BookingPaymentStatus.CANCELLED;
      booking.paidAt = null;
      booking.paymentReference = null;
      booking.paymentTransactionId = null;
    }

    const savedBooking = booking;
    await this.notifyPassengerAboutAutomaticNoShow(savedBooking);
    await this.recalculateAvailableSeatsForTrip(savedBooking.tripId);
    await this.touchTripInteraction(savedBooking.tripId);
    await this.invalidateBookingCaches(savedBooking);

    this.logger.warn(
      JSON.stringify({
        event: 'passenger_no_show_confirmed',
        bookingId: savedBooking.id,
        tripId: savedBooking.tripId,
        passengerId: savedBooking.passengerId,
        detectedAt: now.toISOString(),
        driverDistanceFromPickupMeters: Math.round(driverDistanceFromPickup),
        paymentStatus: savedBooking.paymentStatus,
      }),
    );

    return {
      type: 'passenger_no_show',
      bookingId: savedBooking.id,
      tripId: savedBooking.tripId,
      passengerId: savedBooking.passengerId,
      distanceMeters: Math.round(driverDistanceFromPickup),
      detectedAt: now.toISOString(),
      noShowReason: savedBooking.noShowReason ?? undefined,
    };
  }

  private async tryConfirmAutomaticDropoff(
    booking: Booking,
  ): Promise<AutomaticRideProgressEvent | null> {
    if (
      !this.canEvaluateAutomaticProgress(booking) ||
      !this.hasBookingBeenPickedUpForRideProgress(booking) ||
      booking.droppedOff
    ) {
      return null;
    }

    const now = new Date();
    const driverLocation = booking.trip?.currentLocation ?? null;
    const dropoffPoint = this.getDropoffPoint(booking);
    if (
      !driverLocation ||
      !dropoffPoint ||
      !this.isFreshLocationUpdate(booking.trip?.lastLocationUpdateAt, now)
    ) {
      return null;
    }

    const driverDistanceToDestination = this.calculatePointDistanceMeters(
      driverLocation,
      dropoffPoint,
    );
    if (
      driverDistanceToDestination !== null &&
      driverDistanceToDestination <=
        this.AUTO_DROPOFF_DIRECT_CONFIRM_THRESHOLD_METERS
    ) {
      return this.completeAutomaticDropoff(
        booking,
        now,
        'automatic_driver_destination',
      );
    }

    if (
      !booking.passengerDestinationApproachNotifiedAt ||
      !this.hasFreshGpsPair(booking, now)
    ) {
      return null;
    }

    const passengerLocation = booking.passengerCurrentLocation ?? null;
    if (!passengerLocation) {
      return null;
    }

    const passengerDistanceToDestination = this.calculatePointDistanceMeters(
      passengerLocation,
      dropoffPoint,
    );
    const driverPassengerDistance = this.calculatePointDistanceMeters(
      driverLocation,
      passengerLocation,
    );
    const [driverHistory, passengerHistory] = await Promise.all([
      this.locationHistoryService.getDriverLocationHistory(booking.tripId),
      this.locationHistoryService.getPassengerLocationHistory(booking.id),
    ]);
    if (
      driverDistanceToDestination === null ||
      passengerDistanceToDestination === null ||
      driverPassengerDistance === null ||
      passengerDistanceToDestination >
        this.AUTO_DROPOFF_PASSENGER_STAY_THRESHOLD_METERS ||
      !this.hasDriverContinuedAfterDropoffFromHistory(
        driverHistory,
        dropoffPoint,
        now,
      ) ||
      driverPassengerDistance <
        this.AUTO_DROPOFF_DRIVER_PASSENGER_SEPARATION_THRESHOLD_METERS ||
      this.areDriverAndPassengerMovingTogetherFromHistory(
        driverHistory,
        passengerHistory,
        now,
      )
    ) {
      return null;
    }

    return this.completeAutomaticDropoff(
      booking,
      now,
      'automatic_passenger_separation',
    );
  }

  private async completeAutomaticDropoff(
    booking: Booking,
    now: Date,
    detectionMethod: string,
  ): Promise<AutomaticRideProgressEvent | null> {
    const pickedUpAt = booking.pickedUpAt ?? now;
    const passengerDestinationApproachNotifiedAt =
      booking.passengerDestinationApproachNotifiedAt ?? now;
    const droppedOffAt = booking.droppedOffAt ?? now;
    const dropoffDetectionMethod =
      booking.dropoffDetectionMethod ?? detectionMethod;
    const updateResult = await this.bookingRepository.update(
      {
        id: booking.id,
        status: BookingStatus.ACCEPTED,
        droppedOff: false,
      },
      {
        pickedUp: true,
        pickedUpAt,
        passengerDestinationApproachNotifiedAt,
        droppedOff: true,
        droppedOffAt,
        dropoffDetectionMethod,
        status: BookingStatus.COMPLETED,
      },
    );
    if (updateResult.affected !== 1) {
      this.logger.debug(
        `Automatic dropoff already completed for booking ${booking.id}`,
      );
      return null;
    }

    booking.pickedUp = true;
    booking.pickedUpAt = pickedUpAt;
    booking.passengerDestinationApproachNotifiedAt =
      passengerDestinationApproachNotifiedAt;
    booking.droppedOff = true;
    booking.droppedOffAt = droppedOffAt;
    booking.dropoffDetectionMethod = dropoffDetectionMethod;
    booking.status = BookingStatus.COMPLETED;

    let savedBooking = booking;
    savedBooking = await this.settlePaymentAfterArrival(savedBooking);
    await this.touchTripInteraction(savedBooking.tripId);
    await this.notifySelectedEmergencyContacts(savedBooking, 'dropoff');
    await this.notifyPassengerAboutAutomaticDropoffConfirmation(savedBooking);
    await this.notifyDriverAboutAutomaticDropoffConfirmation(savedBooking);
    await this.invalidateBookingCaches(savedBooking);

    return {
      type: 'dropoff_confirmed',
      bookingId: savedBooking.id,
      tripId: savedBooking.tripId,
      passengerId: savedBooking.passengerId,
      detectedAt: now.toISOString(),
      detectionMethod,
    };
  }

  private async notifySelectedEmergencyContacts(
    booking: Booking,
    eventType: 'pickup' | 'dropoff' | 'trip_end_without_dropoff',
  ): Promise<void> {
    try {
      const selectedContactIds = booking.safetyEmergencyContactIds ?? [];
      if (selectedContactIds.length === 0) {
        this.logger.debug(
          `No selected emergency contacts for booking ${booking.id}, skipping ${eventType} WhatsApp notification`,
        );
        return;
      }

      const trip = await this.tripRepository.findOne({
        where: { id: booking.tripId },
        relations: ['driver', 'vehicle', 'bookings', 'bookings.passenger'],
      });
      if (!trip) {
        this.logger.warn(
          `Trip not found while notifying emergency contacts for booking ${booking.id}`,
        );
        return;
      }

      const passenger =
        booking.passenger ??
        (await this.userRepository.findOne({
          where: { id: booking.passengerId },
          select: ['id', 'firstName', 'lastName'],
        }));

      const emergencyContacts =
        await this.safetyService.findAllEmergencyContacts(booking.passengerId);
      const selectedContacts = emergencyContacts.filter(
        (contact) =>
          contact.isActive &&
          !!contact.phone &&
          selectedContactIds.includes(contact.id),
      );

      if (selectedContacts.length === 0) {
        this.logger.debug(
          `Selected emergency contacts are missing/inactive for booking ${booking.id}, skipping ${eventType} WhatsApp notification`,
        );
        return;
      }

      this.logger.log(
        `[WA][EmergencyContact][${eventType}] booking=${booking.id} trip=${booking.tripId} selected=${selectedContacts.length}`,
      );

      const passengerName = passenger
        ? `${passenger.firstName} ${passenger.lastName}`.trim()
        : 'Le passager';
      const driverName = trip.driver
        ? `${trip.driver.firstName} ${trip.driver.lastName}`.trim()
        : 'Le conducteur';
      const driverPhone = trip.driver?.phone ?? null;
      const vehicleDetails = this.buildVehicleSafetyLabel(trip);
      const otherPassengerNames = this.getOtherConfirmedPassengerNames(
        trip.bookings ?? [],
        booking.passengerId,
      );
      const message = this.buildEmergencyContactSafetyMessage(
        booking,
        trip,
        passengerName,
        driverName,
        driverPhone,
        vehicleDetails,
        otherPassengerNames,
        eventType,
      );

      let success = 0;
      let failed = 0;
      for (const contact of selectedContacts) {
        this.logger.debug(
          `[WA][EmergencyContact][${eventType}] booking=${booking.id} contactId=${contact.id} phone=${contact.phone} sending...`,
        );
        const sent = await this.messagingService.sendMessage(
          contact.phone,
          message,
          {
            flow: 'booking_passenger_safety',
            eventType,
            bookingId: booking.id,
            tripId: booking.tripId,
            contactId: contact.id,
            passengerId: booking.passengerId,
          },
        );
        if (sent) {
          success += 1;
          this.logger.log(
            `[WA][EmergencyContact][${eventType}] booking=${booking.id} contactId=${contact.id} status=sent`,
          );
        } else {
          failed += 1;
          this.logger.warn(
            `[WA][EmergencyContact][${eventType}] booking=${booking.id} contactId=${contact.id} status=failed`,
          );
        }
      }

      this.logger.log(
        `[EmergencyContact][${eventType}] booking ${booking.id}: ${success} sent, ${failed} failed`,
      );
    } catch (error) {
      this.logger.warn(
        `Emergency contact WhatsApp notification skipped for booking ${booking.id} (${eventType}): ${error.message}`,
      );
    }
  }

  private buildEmergencyContactSafetyMessage(
    booking: Booking,
    trip: Trip,
    passengerName: string,
    driverName: string,
    driverPhone: string | null,
    vehicleDetails: string,
    otherPassengerNames: string[],
    eventType: 'pickup' | 'dropoff' | 'trip_end_without_dropoff',
  ): string {
    const departure = trip.departureLocation;
    const arrival = booking.passengerDestination || trip.arrivalLocation;
    const driverLabel = driverPhone
      ? `${driverName} (${driverPhone})`
      : driverName;
    const otherPassengersLabel =
      otherPassengerNames.length > 0
        ? otherPassengerNames.join(', ')
        : 'aucun autre passager confirme';

    if (eventType === 'dropoff') {
      return [
        'ZWANGA - Mise a jour securite',
        `${passengerName} est bien arrive(e).`,
        `Depart: ${departure}.`,
        `Arrivee: ${arrival}.`,
        `Conducteur: ${driverLabel}.`,
        `Vehicule: ${vehicleDetails}.`,
        `Autres passagers: ${otherPassengersLabel}.`,
      ].join('\n');
    }

    if (eventType === 'trip_end_without_dropoff') {
      return [
        'ZWANGA - Alerte securite',
        `Le trajet est termine mais l'arrivee de ${passengerName} n'a pas ete confirmee.`,
        `Depart: ${departure}.`,
        `Arrivee: ${arrival}.`,
        `Conducteur: ${driverLabel}.`,
        `Vehicule: ${vehicleDetails}.`,
        `Autres passagers: ${otherPassengersLabel}.`,
      ].join('\n');
    }

    return [
      'ZWANGA - Mise a jour securite',
      `${passengerName} vient d'embarquer.`,
      `Depart: ${departure}.`,
      `Arrivee: ${arrival}.`,
      `Conducteur: ${driverLabel}.`,
      `Vehicule: ${vehicleDetails}.`,
      `Autres passagers: ${otherPassengersLabel}.`,
    ].join('\n');
  }

  private async notifyDriverEmergencyContactsOnPickup(
    booking: Booking,
  ): Promise<void> {
    try {
      const trip = await this.tripRepository.findOne({
        where: { id: booking.tripId },
        relations: ['driver', 'vehicle', 'bookings', 'bookings.passenger'],
      });
      if (!trip) {
        return;
      }

      const selectedContactIds = trip.driverSafetyEmergencyContactIds ?? [];
      if (selectedContactIds.length === 0) {
        return;
      }

      const emergencyContacts =
        await this.safetyService.findAllEmergencyContacts(trip.driverId);
      const selectedContacts = emergencyContacts.filter(
        (contact) =>
          contact.isActive &&
          !!contact.phone &&
          selectedContactIds.includes(contact.id),
      );

      if (selectedContacts.length === 0) {
        return;
      }

      this.logger.log(
        `[WA][DriverEmergencyContact][pickup] booking=${booking.id} trip=${booking.tripId} selected=${selectedContacts.length}`,
      );

      const passengerName = booking.passenger
        ? `${booking.passenger.firstName} ${booking.passenger.lastName}`.trim()
        : 'Un passager';
      const driverName = trip.driver
        ? `${trip.driver.firstName} ${trip.driver.lastName}`.trim()
        : 'Le conducteur';
      const vehicleDetails = this.buildVehicleSafetyLabel(trip);
      const passengerNames = this.getConfirmedPassengerNames(
        trip.bookings ?? [],
      );
      const passengersLabel =
        passengerNames.length > 0
          ? passengerNames.join(', ')
          : 'aucun passager confirme';

      const message = [
        'ZWANGA - Mise a jour securite conducteur',
        `${driverName} vient de recuperer ${passengerName}.`,
        `Depart: ${trip.departureLocation}.`,
        `Arrivee: ${trip.arrivalLocation}.`,
        `Conducteur: ${driverName}.`,
        `Vehicule: ${vehicleDetails}.`,
        `Passagers: ${passengersLabel}.`,
      ].join('\n');

      let success = 0;
      let failed = 0;
      for (const contact of selectedContacts) {
        this.logger.debug(
          `[WA][DriverEmergencyContact][pickup] booking=${booking.id} contactId=${contact.id} phone=${contact.phone} sending...`,
        );
        const sent = await this.messagingService.sendMessage(
          contact.phone,
          message,
          {
            flow: 'booking_driver_safety',
            eventType: 'driver_pickup',
            bookingId: booking.id,
            tripId: booking.tripId,
            contactId: contact.id,
            driverId: trip.driverId,
          },
        );
        if (sent) {
          success += 1;
          this.logger.log(
            `[WA][DriverEmergencyContact][pickup] booking=${booking.id} contactId=${contact.id} status=sent`,
          );
        } else {
          failed += 1;
          this.logger.warn(
            `[WA][DriverEmergencyContact][pickup] booking=${booking.id} contactId=${contact.id} status=failed`,
          );
        }
      }

      this.logger.log(
        `[DriverEmergencyContact][pickup] booking ${booking.id}: ${success} sent, ${failed} failed`,
      );
    } catch (error) {
      this.logger.warn(
        `Driver emergency contact pickup notification skipped for booking ${booking.id}: ${error.message}`,
      );
    }
  }

  private buildVehicleSafetyLabel(trip: Trip): string {
    if (!trip.vehicle) {
      return 'vehicule non renseigne';
    }
    const brandModel = [trip.vehicle.brand, trip.vehicle.model]
      .filter(Boolean)
      .join(' ');
    const color = trip.vehicle.color ? `, couleur ${trip.vehicle.color}` : '';
    const plate = trip.vehicle.licensePlate
      ? `, plaque ${trip.vehicle.licensePlate}`
      : '';
    return `${brandModel || 'vehicule'}${color}${plate}`;
  }

  private getConfirmedPassengerNames(bookings: Booking[]): string[] {
    const seen = new Set<string>();
    const names: string[] = [];

    for (const booking of bookings) {
      const isConfirmedPassenger =
        booking.status === BookingStatus.ACCEPTED ||
        booking.status === BookingStatus.COMPLETED ||
        booking.pickedUp ||
        booking.pickedUpConfirmedByPassenger ||
        booking.droppedOff ||
        booking.droppedOffConfirmedByPassenger;

      if (!isConfirmedPassenger || !booking.passenger) {
        continue;
      }

      const name =
        `${booking.passenger.firstName ?? ''} ${booking.passenger.lastName ?? ''}`.trim();
      if (!name) {
        continue;
      }
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      names.push(name);
    }

    return names;
  }

  private getOtherConfirmedPassengerNames(
    bookings: Booking[],
    currentPassengerId: string,
  ): string[] {
    return this.getConfirmedPassengerNames(
      bookings.filter((booking) => booking.passengerId !== currentPassengerId),
    );
  }

  async reportBookingProblem(
    bookingId: string,
    userId: string,
    reportDto: ReportBookingProblemDto,
  ): Promise<any> {
    this.logger.log(
      `User ${userId} reporting problem for booking ${bookingId}`,
    );

    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Réservation non trouvée');
    }

    // Verify user is either driver or passenger
    const isDriver = booking.trip.driverId === userId;
    const isPassenger = booking.passengerId === userId;

    if (!isDriver && !isPassenger) {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à signaler des problèmes pour cette réservation",
      );
    }

    // Determine reported user (opposite party)
    const reportedUserId = isDriver
      ? booking.passengerId
      : booking.trip.driverId;

    // Create report using SafetyService
    const report = await this.safetyService.createUserReport(userId, {
      reportedUserId,
      reason: reportDto.reason,
      description: reportDto.description,
      tripId: booking.tripId,
      bookingId: booking.id,
    });

    this.logger.log(
      `Problem reported for booking ${bookingId} by user ${userId}`,
    );
    return report;
  }

  private async notifyDriverAboutPassengerInterruptionRequest(
    booking: Booking,
    request: PassengerTripInterruptionRequest,
  ): Promise<void> {
    try {
      const driver = await this.userRepository.findOne({
        where: { id: booking.trip.driverId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!driver?.fcmToken) {
        return;
      }

      const passengerName = booking.passenger
        ? `${booking.passenger.firstName} ${booking.passenger.lastName}`.trim()
        : 'Un passager';

      await this.notificationService.sendNotification(
        driver.fcmToken,
        "Demande d'interruption",
        `${passengerName} demande a descendre avant sa destination.`,
        {
          type: 'passenger_trip_interruption_requested',
          bookingId: booking.id,
          tripId: booking.tripId,
          requestId: request.id,
          role: 'driver',
        },
        booking.trip.driverId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify driver about passenger interruption request: ${error.message}`,
        error.stack,
      );
    }
  }

  private async notifyPassengerAboutPassengerInterruptionDecision(
    booking: Booking,
    approved: boolean,
  ): Promise<void> {
    try {
      const passenger = await this.userRepository.findOne({
        where: { id: booking.passengerId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!passenger?.fcmToken) {
        return;
      }

      await this.notificationService.sendNotification(
        passenger.fcmToken,
        approved ? 'Interruption confirmee' : 'Interruption refusee',
        approved
          ? 'Le conducteur a confirme votre descente avant destination.'
          : "Le conducteur a refuse votre demande d'interruption.",
        {
          type: approved
            ? 'passenger_trip_interruption_confirmed'
            : 'passenger_trip_interruption_rejected',
          bookingId: booking.id,
          tripId: booking.tripId,
          role: 'passenger',
        },
        booking.passengerId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify passenger about interruption decision: ${error.message}`,
        error.stack,
      );
    }
  }

  private async notifyPassengerAboutPickupConfirmation(
    booking: Booking,
  ): Promise<void> {
    try {
      const passenger = await this.userRepository.findOne({
        where: { id: booking.passengerId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!passenger?.fcmToken) {
        this.logger.debug(
          `Passenger ${booking.passengerId} has no FCM token, skipping notification`,
        );
        return;
      }

      await this.notificationService.sendNotification(
        passenger.fcmToken,
        '✅ Récupération confirmée',
        `Le conducteur a confirmé votre récupération pour le trajet ${booking.trip.departureLocation} → ${booking.passengerDestination || booking.trip.arrivalLocation}. Veuillez confirmer également.`,
        {
          type: 'pickup_confirmed_by_driver',
          bookingId: booking.id,
          tripId: booking.tripId,
        },
        booking.passengerId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify passenger about pickup: ${error.message}`,
        error.stack,
      );
    }
  }

  private async notifyDriverAboutPickupConfirmation(
    booking: Booking,
  ): Promise<void> {
    try {
      const driver = await this.userRepository.findOne({
        where: { id: booking.trip.driverId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!driver?.fcmToken) {
        this.logger.debug(
          `Driver ${booking.trip.driverId} has no FCM token, skipping notification`,
        );
        return;
      }

      const passenger = await this.userRepository.findOne({
        where: { id: booking.passengerId },
        select: ['firstName', 'lastName'],
      });
      const passengerName = passenger
        ? `${passenger.firstName} ${passenger.lastName}`
        : 'Le passager';

      await this.notificationService.sendNotification(
        driver.fcmToken,
        '✅ Récupération confirmée',
        `${passengerName} a confirmé la récupération pour le trajet ${booking.trip.departureLocation} → ${booking.passengerDestination || booking.trip.arrivalLocation}.`,
        {
          type: 'pickup_confirmed_by_passenger',
          bookingId: booking.id,
          tripId: booking.tripId,
          role: 'driver',
        },
        booking.trip.driverId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify driver about pickup confirmation: ${error.message}`,
        error.stack,
      );
    }
  }

  private async notifyPassengerAboutDropoffConfirmation(
    booking: Booking,
  ): Promise<void> {
    try {
      const passenger = await this.userRepository.findOne({
        where: { id: booking.passengerId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!passenger?.fcmToken) {
        this.logger.debug(
          `Passenger ${booking.passengerId} has no FCM token, skipping notification`,
        );
        return;
      }

      await this.notificationService.sendNotification(
        passenger.fcmToken,
        'Arrivée confirmée',
        `Le conducteur a confirmé votre arrivée pour le trajet ${booking.trip.departureLocation} → ${booking.passengerDestination || booking.trip.arrivalLocation}. La réservation est maintenant complétée.`,
        {
          type: 'dropoff_confirmed_by_driver',
          bookingId: booking.id,
          tripId: booking.tripId,
        },
        booking.passengerId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify passenger about dropoff: ${error.message}`,
        error.stack,
      );
    }
  }

  private async notifyDriverAboutDropoffConfirmation(
    booking: Booking,
  ): Promise<void> {
    try {
      const driver = await this.userRepository.findOne({
        where: { id: booking.trip.driverId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!driver?.fcmToken) {
        this.logger.debug(
          `Driver ${booking.trip.driverId} has no FCM token, skipping notification`,
        );
        return;
      }

      const passenger = await this.userRepository.findOne({
        where: { id: booking.passengerId },
        select: ['firstName', 'lastName'],
      });
      const passengerName = passenger
        ? `${passenger.firstName} ${passenger.lastName}`
        : 'Le passager';

      await this.notificationService.sendNotification(
        driver.fcmToken,
        'Arrivée signalée',
        `${passengerName} a signalé son arrivée pour le trajet ${booking.trip.departureLocation} → ${booking.passengerDestination || booking.trip.arrivalLocation}. Confirmez son arrivée côté conducteur.`,
        {
          type: 'dropoff_requested_by_passenger',
          bookingId: booking.id,
          tripId: booking.tripId,
          role: 'driver',
        },
        booking.trip.driverId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify driver about dropoff confirmation: ${error.message}`,
        error.stack,
      );
    }
  }

  private async notifyPassengerAboutAutomaticNoShow(
    booking: Booking,
  ): Promise<void> {
    try {
      const passenger =
        booking.passenger ??
        (await this.userRepository.findOne({
          where: { id: booking.passengerId },
          select: ['id', 'fcmToken'],
        }));
      if (!passenger?.fcmToken) {
        return;
      }

      const driverDistanceMeters =
        booking.noShowDriverDistanceMeters ??
        this.AUTO_NO_SHOW_DRIVER_DEPARTURE_THRESHOLD_METERS;
      const detectedAt =
        booking.noShowDetectedAt?.toISOString() ?? new Date().toISOString();

      await this.notificationService.sendNotification(
        passenger.fcmToken,
        'Le conducteur est deja parti',
        `Le conducteur est maintenant a environ ${driverDistanceMeters} m du point de rendez-vous et votre prise en charge n'a pas ete detectee. Aucun paiement n'a ete effectue. Gardez votre localisation active si vous rejoignez le vehicule pendant le trajet.`,
        {
          type: 'passenger_no_show',
          bookingId: booking.id,
          tripId: booking.tripId,
          role: 'passenger',
          distanceMeters: driverDistanceMeters,
          detectedAt,
          keepLocationActive: true,
        },
        booking.passengerId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify passenger about automatic no-show: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async notifyPassengerAboutAutomaticBoardingUncertain(
    booking: Booking,
  ): Promise<void> {
    try {
      const passenger =
        booking.passenger ??
        (await this.userRepository.findOne({
          where: { id: booking.passengerId },
          select: ['id', 'fcmToken'],
        }));
      if (!passenger?.fcmToken) {
        return;
      }

      await this.notificationService.sendNotification(
        passenger.fcmToken,
        'Embarquement non confirme',
        "Le trajet est termine, mais les donnees GPS n'ont pas permis de confirmer votre embarquement. Aucun paiement n'a ete effectue.",
        {
          type: 'passenger_boarding_uncertain',
          bookingId: booking.id,
          tripId: booking.tripId,
          role: 'passenger',
        },
        booking.passengerId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify passenger about uncertain boarding: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async notifyPassengerAboutAutomaticPickupConfirmation(
    booking: Booking,
  ): Promise<void> {
    try {
      const passenger = await this.userRepository.findOne({
        where: { id: booking.passengerId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!passenger?.fcmToken) {
        return;
      }

      await this.notificationService.sendNotification(
        passenger.fcmToken,
        'Recuperation confirmee',
        `Votre recuperation a ete confirmee automatiquement par GPS pour le trajet ${booking.trip.departureLocation} -> ${booking.passengerDestination || booking.trip.arrivalLocation}.`,
        {
          type: 'pickup_confirmed_automatically',
          bookingId: booking.id,
          tripId: booking.tripId,
        },
        booking.passengerId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify passenger about automatic pickup: ${error.message}`,
        error.stack,
      );
    }
  }

  private async notifyDriverAboutAutomaticPickupConfirmation(
    booking: Booking,
  ): Promise<void> {
    try {
      const driver = await this.userRepository.findOne({
        where: { id: booking.trip.driverId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!driver?.fcmToken) {
        return;
      }

      const passengerName = booking.passenger
        ? `${booking.passenger.firstName} ${booking.passenger.lastName}`.trim()
        : 'Le passager';

      await this.notificationService.sendNotification(
        driver.fcmToken,
        'Passager recupere',
        `${passengerName} est marque comme recupere automatiquement par GPS.`,
        {
          type: 'pickup_confirmed_automatically',
          bookingId: booking.id,
          tripId: booking.tripId,
          passengerId: booking.passengerId,
          role: 'driver',
        },
        booking.trip.driverId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify driver about automatic pickup: ${error.message}`,
        error.stack,
      );
    }
  }

  private async notifyPassengerAboutAutomaticDropoffConfirmation(
    booking: Booking,
  ): Promise<void> {
    try {
      const passenger = await this.userRepository.findOne({
        where: { id: booking.passengerId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!passenger?.fcmToken) {
        return;
      }

      await this.notificationService.sendNotification(
        passenger.fcmToken,
        'Arrivee confirmee',
        `Votre arrivee a ete confirmee automatiquement par GPS pour le trajet ${booking.trip.departureLocation} -> ${booking.passengerDestination || booking.trip.arrivalLocation}.`,
        {
          type: 'dropoff_confirmed_automatically',
          bookingId: booking.id,
          tripId: booking.tripId,
        },
        booking.passengerId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify passenger about automatic dropoff: ${error.message}`,
        error.stack,
      );
    }
  }

  private async notifyDriverAboutAutomaticDropoffConfirmation(
    booking: Booking,
  ): Promise<void> {
    try {
      const driver = await this.userRepository.findOne({
        where: { id: booking.trip.driverId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!driver?.fcmToken) {
        return;
      }

      const passengerName = booking.passenger
        ? `${booking.passenger.firstName} ${booking.passenger.lastName}`.trim()
        : 'Le passager';

      await this.notificationService.sendNotification(
        driver.fcmToken,
        'Arrivee confirmee',
        `${passengerName} est marque comme depose automatiquement par GPS.`,
        {
          type: 'dropoff_confirmed_automatically',
          bookingId: booking.id,
          tripId: booking.tripId,
          passengerId: booking.passengerId,
          role: 'driver',
        },
        booking.trip.driverId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify driver about automatic dropoff: ${error.message}`,
        error.stack,
      );
    }
  }

  async getWhatsAppNotificationData(
    bookingId: string,
    passengerId: string,
    sendDto: SendWhatsAppNotificationDto,
  ): Promise<{
    message: string;
    contacts: Array<{ id: string; name: string; phone: string }>;
    tripDetails: {
      departureLocation: string;
      arrivalLocation: string;
      departureDate: Date;
      vehicleColor: string;
      licensePlate: string;
      driverName: string;
      driverPhone: string;
    };
  }> {
    this.logger.log(
      `Getting WhatsApp notification data for booking ${bookingId} by passenger ${passengerId}`,
    );

    // Vérifier que la réservation appartient au passager
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
      relations: ['trip', 'trip.driver', 'trip.vehicle', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Réservation non trouvée');
    }

    // Vérifier que la réservation est acceptée
    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException(
        'Vous ne pouvez envoyer des notifications que pour une réservation acceptée',
      );
    }

    // Récupérer les contacts d'urgence
    const emergencyContacts =
      await this.safetyService.findAllEmergencyContacts(passengerId);
    const selectedContacts = emergencyContacts.filter((contact) =>
      sendDto.emergencyContactIds.includes(contact.id),
    );

    if (selectedContacts.length !== sendDto.emergencyContactIds.length) {
      throw new BadRequestException(
        "Certains contacts d'urgence sélectionnés n'existent pas",
      );
    }

    // Vérifier que tous les contacts sont actifs
    const inactiveContacts = selectedContacts.filter(
      (contact) => !contact.isActive,
    );
    if (inactiveContacts.length > 0) {
      throw new BadRequestException(
        `Certains contacts d'urgence ne sont pas actifs: ${inactiveContacts.map((c) => c.name).join(', ')}`,
      );
    }

    // Récupérer les informations du véhicule
    booking.safetyEmergencyContactIds = selectedContacts.map(
      (contact) => contact.id,
    );
    await this.bookingRepository.save(booking);
    this.logger.log(
      `Saved ${booking.safetyEmergencyContactIds.length} emergency contact(s) for booking ${booking.id}`,
    );

    const trip = booking.trip;
    if (!trip.vehicle) {
      throw new BadRequestException('Aucun véhicule associé à ce trajet');
    }

    const vehicle = trip.vehicle;
    const driver =
      trip.driver ||
      (await this.userRepository.findOne({ where: { id: trip.driverId } }));
    const passenger =
      booking.passenger ||
      (await this.userRepository.findOne({ where: { id: passengerId } }));

    if (!driver) {
      throw new NotFoundException('Conducteur non trouvé');
    }

    if (!passenger) {
      throw new NotFoundException('Passager non trouvé');
    }

    // Générer le message WhatsApp
    const message = this.messagingService.generateTripNotificationMessage({
      passengerName: `${passenger.firstName} ${passenger.lastName}`,
      departureLocation: trip.departureLocation,
      arrivalLocation: trip.arrivalLocation,
      departureDate: trip.departureDate,
      vehicleColor: vehicle.color,
      licensePlate: vehicle.licensePlate,
      driverName: `${driver.firstName} ${driver.lastName}`,
      driverPhone: driver.phone,
    });

    // Retourner les données pour le frontend
    return {
      message,
      contacts: selectedContacts.map((contact) => ({
        id: contact.id,
        name: contact.name,
        phone: contact.phone,
      })),
      tripDetails: {
        departureLocation: trip.departureLocation,
        arrivalLocation: trip.arrivalLocation,
        departureDate: trip.departureDate,
        vehicleColor: vehicle.color,
        licensePlate: vehicle.licensePlate,
        driverName: `${driver.firstName} ${driver.lastName}`,
        driverPhone: driver.phone,
      },
    };
  }

  async updatePassengerLocation(
    passengerId: string,
    bookingId: string,
    updateLocationDto: UpdatePassengerLocationDto,
  ): Promise<{
    tripId: string;
    bookingId: string;
    coordinates: [number, number];
    updatedAt: Date;
    autoProgress: AutomaticRideProgressResult;
  }> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
      relations: ['trip'],
    });

    if (!booking) {
      throw new NotFoundException(
        "Réservation non trouvée ou vous n'êtes pas le passager",
      );
    }

    // Vérifier que la réservation est acceptée
    if (
      ![BookingStatus.ACCEPTED, BookingStatus.NO_SHOW].includes(booking.status)
    ) {
      throw new BadRequestException(
        'Seules les reservations acceptees ou recuperables peuvent partager leur position',
      );
    }

    // Vérifier que le trajet est actif
    if (booking.trip.status !== TripStatus.ACTIVE) {
      throw new BadRequestException(
        'Le trajet doit être actif pour partager la position',
      );
    }

    // Construire le point de position
    const currentCoordinate = normalizeCoordinateForTrip(
      updateLocationDto.latitude,
      updateLocationDto.longitude,
      booking.trip,
    );
    if (!currentCoordinate) {
      throw new BadRequestException(
        'Position passager invalide ou incoherente avec le trajet',
      );
    }

    // Mettre à jour la position
    const observedAt = normalizeLocationRecordedAt(
      updateLocationDto.recordedAt,
    );
    const previousTimestamp = booking.passengerLastLocationUpdateAt
      ? new Date(booking.passengerLastLocationUpdateAt).getTime()
      : 0;
    if (previousTimestamp >= observedAt.getTime()) {
      const autoProgress = await this.evaluateAutomaticRideProgressForTrip(
        booking.tripId,
      );
      const existingCoordinates = booking.passengerCurrentLocation?.coordinates;
      return {
        tripId: booking.tripId,
        bookingId: booking.id,
        coordinates: [
          Number(existingCoordinates?.[0] ?? currentCoordinate.longitude),
          Number(existingCoordinates?.[1] ?? currentCoordinate.latitude),
        ],
        updatedAt: booking.passengerLastLocationUpdateAt!,
        autoProgress,
      };
    }

    const passengerCurrentLocation =
      buildPointFromCoordinate(currentCoordinate);
    const updateResult = await this.bookingRepository.update(
      {
        id: booking.id,
        passengerId,
        status: In([BookingStatus.ACCEPTED, BookingStatus.NO_SHOW]),
        passengerLastLocationUpdateAt: Raw(
          (alias) => `(${alias} IS NULL OR ${alias} < :observedAt)`,
          { observedAt },
        ),
      },
      {
        passengerCurrentLocation,
        passengerLastLocationUpdateAt: observedAt,
      },
    );
    if (updateResult.affected !== 1) {
      const latestBooking = await this.bookingRepository.findOne({
        where: { id: booking.id, passengerId },
        relations: ['trip'],
      });
      const autoProgress = await this.evaluateAutomaticRideProgressForTrip(
        booking.tripId,
      );
      const existingCoordinates =
        latestBooking?.passengerCurrentLocation?.coordinates ??
        booking.passengerCurrentLocation?.coordinates;
      return {
        tripId: booking.tripId,
        bookingId: booking.id,
        coordinates: [
          Number(existingCoordinates?.[0] ?? currentCoordinate.longitude),
          Number(existingCoordinates?.[1] ?? currentCoordinate.latitude),
        ],
        updatedAt:
          latestBooking?.passengerLastLocationUpdateAt ??
          booking.passengerLastLocationUpdateAt ??
          observedAt,
        autoProgress,
      };
    }

    booking.passengerCurrentLocation = passengerCurrentLocation;
    booking.passengerLastLocationUpdateAt = observedAt;
    await this.locationHistoryService.recordPassengerLocation(
      booking.id,
      currentCoordinate.latitude,
      currentCoordinate.longitude,
      booking.passengerLastLocationUpdateAt,
      {
        accuracyMeters: updateLocationDto.accuracy,
        speedMetersPerSecond: updateLocationDto.speed,
        headingDegrees: updateLocationDto.heading,
      },
    );
    await this.touchTripInteraction(booking.tripId);

    // Vérifier la proximité de la destination et notifier si nécessaire
    await this.checkAndNotifyDestinationProximity(booking);
    const autoProgress = await this.evaluateAutomaticRideProgressForTrip(
      booking.tripId,
    );

    const responseCoordinates: [number, number] = [
      currentCoordinate.longitude,
      currentCoordinate.latitude,
    ];

    return {
      tripId: booking.tripId,
      bookingId: booking.id,
      coordinates: responseCoordinates,
      updatedAt: booking.passengerLastLocationUpdateAt!,
      autoProgress,
    };
  }

  /**
   * Calcule la distance en mètres entre la position actuelle du passager et sa destination
   */
  private async touchTripInteraction(tripId: string): Promise<void> {
    try {
      await this.tripRepository
        .createQueryBuilder()
        .update(Trip)
        .set({ updatedAt: () => 'CURRENT_TIMESTAMP' } as any)
        .where('id = :tripId', { tripId })
        .execute();
    } catch (error) {
      this.logger.warn(
        `Unable to refresh interaction timestamp for trip ${tripId}: ${error.message}`,
      );
    }
  }

  private async calculateDistanceToDestination(
    booking: Booking,
  ): Promise<number | null> {
    if (
      !booking.passengerCurrentLocation ||
      !booking.passengerDestinationPoint
    ) {
      return null;
    }

    try {
      // Utiliser PostGIS ST_Distance pour calculer la distance en mètres
      const result = await this.bookingRepository
        .createQueryBuilder('booking')
        .select(
          `ST_Distance(
            booking.passengerCurrentLocation::geography,
            booking.passengerDestinationPoint::geography
          )`,
          'distance',
        )
        .where('booking.id = :id', { id: booking.id })
        .getRawOne();

      return result?.distance ? Math.round(result.distance) : null;
    } catch (error) {
      this.logger.error(
        `Error calculating distance to destination: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Vérifie si le passager est proche de sa destination et envoie les notifications si nécessaire
   */
  private async checkAndNotifyDestinationProximity(
    booking: Booking,
  ): Promise<void> {
    // Ne pas vérifier si la notification a déjà été envoyée
    if (booking.destinationProximityNotified) {
      return;
    }

    // Vérifier que la destination est définie
    if (!booking.passengerDestinationPoint) {
      return;
    }

    // Calculer la distance
    const distance = await this.calculateDistanceToDestination(booking);

    if (
      distance === null ||
      distance > this.DESTINATION_PROXIMITY_THRESHOLD_METERS
    ) {
      return;
    }

    this.logger.log(
      `Passenger ${booking.passengerId} is ${distance}m away from destination for booking ${booking.id}. Sending notifications.`,
    );

    // Marquer comme notifié et envoyer les notifications
    booking.destinationProximityNotified = true;
    await this.bookingRepository.save(booking);

    // Envoyer les notifications au conducteur et au passager
    await this.notifyDestinationProximity(booking, distance);
  }

  /**
   * Envoie les notifications de proximité au conducteur et au passager
   */
  private async notifyDestinationProximity(
    booking: Booking,
    distanceMeters: number,
  ): Promise<void> {
    try {
      // Charger les relations nécessaires
      const bookingWithRelations = await this.bookingRepository.findOne({
        where: { id: booking.id },
        relations: ['passenger', 'trip', 'trip.driver'],
      });

      if (
        !bookingWithRelations ||
        !bookingWithRelations.trip ||
        !bookingWithRelations.passenger
      ) {
        this.logger.warn(
          `Cannot notify destination proximity: missing relations for booking ${booking.id}`,
        );
        return;
      }

      const trip = bookingWithRelations.trip;
      const passenger = bookingWithRelations.passenger;
      const driver = trip.driver;

      const distanceKm = (distanceMeters / 1000).toFixed(1);
      const destinationName =
        bookingWithRelations.passengerDestination || 'votre destination';

      // Notification au passager
      if (passenger.fcmToken) {
        const passengerTitle = '📍 Proche de votre destination';
        const passengerBody = `Vous êtes à environ ${distanceKm} km de ${destinationName}. Préparez-vous à descendre.`;

        const passengerData = {
          type: 'destination_proximity',
          bookingId: booking.id,
          tripId: trip.id,
          distanceMeters,
          distanceKm: parseFloat(distanceKm),
          destination: destinationName,
        };

        await this.notificationService.sendNotification(
          passenger.fcmToken,
          passengerTitle,
          passengerBody,
          passengerData,
          passenger.id,
        );
        this.logger.log(
          `Notified passenger ${passenger.id} about destination proximity`,
        );
      }

      // Notification au conducteur
      if (driver && driver.fcmToken) {
        const driverTitle = '📍 Passager proche de sa destination';
        const driverBody = `${passenger.firstName} ${passenger.lastName} est à environ ${distanceKm} km de ${destinationName}. Préparez-vous à l'arrêt.`;

        const driverData = {
          type: 'passenger_destination_proximity',
          bookingId: booking.id,
          tripId: trip.id,
          passengerId: passenger.id,
          passengerName: `${passenger.firstName} ${passenger.lastName}`,
          distanceMeters,
          distanceKm: parseFloat(distanceKm),
          destination: destinationName,
        };

        await this.notificationService.sendNotification(
          driver.fcmToken,
          driverTitle,
          driverBody,
          driverData,
          driver.id,
        );
        this.logger.log(
          `Notified driver ${driver.id} about passenger destination proximity`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error notifying destination proximity for booking ${booking.id}: ${error.message}`,
        error.stack,
      );
    }
  }

  async getPassengersLocations(
    tripId: string,
    driverId: string,
  ): Promise<
    Array<{
      bookingId: string;
      passengerId: string;
      passengerName: string;
      coordinates: [number, number] | null;
      lastLocationUpdateAt: Date | null;
    }>
  > {
    this.logger.log(
      `Getting passengers locations for trip ${tripId} by driver ${driverId}`,
    );

    // Vérifier que l'utilisateur est le conducteur du trajet
    const trip = await this.tripRepository.findOne({
      where: { id: tripId, driverId },
    });

    if (!trip) {
      throw new NotFoundException(
        "Trajet non trouvé ou vous n'êtes pas le conducteur",
      );
    }

    // Récupérer toutes les réservations acceptées pour ce trajet
    const acceptedBookings = await this.bookingRepository.find({
      where: {
        tripId,
        status: BookingStatus.ACCEPTED,
      },
      relations: ['passenger'],
      select: [
        'id',
        'passengerId',
        'passengerCurrentLocation',
        'passengerLastLocationUpdateAt',
      ],
    });

    // Convertir les positions en coordonnées
    const now = new Date();

    return acceptedBookings.map((booking) => {
      let coordinates: [number, number] | null = null;
      let lastLocationUpdateAt: Date | null = null;

      const coordinate = this.pointToLatLng(booking.passengerCurrentLocation);
      if (
        coordinate &&
        this.isFreshLocationUpdate(
          booking.passengerLastLocationUpdateAt,
          now,
        ) &&
        isCoordinateAllowedForTrip(coordinate, trip)
      ) {
        coordinates = [coordinate.longitude, coordinate.latitude];
        lastLocationUpdateAt = booking.passengerLastLocationUpdateAt;
      }

      return {
        bookingId: booking.id,
        passengerId: booking.passengerId,
        passengerName: booking.passenger
          ? `${booking.passenger.firstName} ${booking.passenger.lastName}`
          : 'Passager inconnu',
        coordinates,
        lastLocationUpdateAt,
      };
    });
  }
}
