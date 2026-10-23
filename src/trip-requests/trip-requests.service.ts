import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { activeRequestWhere } from '../common/activity-read-policy';
import {
  Repository,
  Point,
  LessThanOrEqual,
  MoreThan,
  Between,
  In,
  IsNull,
  Raw,
  Not,
  EntityManager,
} from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';
import { DriverOffer, DriverOfferStatus } from './entities/driver-offer.entity';
import { User, UserGender, UserRole } from '../users/entities/user.entity';
import {
  getVehicleMaxSeats,
  Vehicle,
  VehicleType,
} from '../vehicles/entities/vehicle.entity';
import {
  CreateTripRequestDto,
  CreateDriverOfferDto,
  AcceptDriverOfferDto,
  AcceptTripRequestDto,
  UpdateTripRequestDto,
  RecommendTripRequestPriceDto,
  TripRequestVehicleOptionsDto,
} from './dto/trip-request.dto';
import { FileUploadService } from '../common/services/file-upload.service';
import { NotificationService } from '../notifications/notifications.service';
import { TripsService } from '../trips/trips.service';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { BookingsService } from '../bookings/bookings.service';
import { BookingStatus } from '../bookings/entities/booking.entity';
import { GoogleMapsService } from '../google-maps/google-maps.service';
import { TravelMode } from '../google-maps/dto/google-maps.dto';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { WeatherAwarenessService } from '../weather/weather-awareness.service';
import { WeatherRouteImpact } from '../weather/weather.types';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { TripRequestRecoveryService } from './trip-request-recovery.service';
import { KycStatus } from '../users/entities/kyc-document.entity';
import { assertDriverCanOperate } from '../users/driver-activation';
import { DriverDispatchService } from './dispatch/dispatch.service';
import { ACCEPTED_REQUEST_EXPIRATION_MS, UNACCEPTED_REQUEST_EXPIRATION_MS, assertRequestSnapshot, assertUnassignedRequest } from './request-edit-policy';
import { enqueueTransactionalNotification } from '../notifications/transactional-notification';
import { HistoryPageQuery, orderHistory } from '../common/history-page';
import { requestPageIds, offerPageIds } from './request-pages';

export interface SanitizedUser {
  id: string;
  firstName: string;
  lastName: string;
  phone?: string;
  gender: UserGender | null;
  profilePicture: string | null;
  isPremium: boolean;
  premiumBadge: boolean;
}

export interface SanitizedVehicle {
  id: string;
  type: VehicleType;
  brand: string;
  model: string;
  color: string;
  licensePlate: string;
  photoUrl: string | null;
}

export interface SanitizedDriverOffer {
  existingTripId?: string | null;
  sharedTripConsentRequired?: boolean;
  id: string;
  driver: SanitizedUser;
  vehicle: SanitizedVehicle | null;
  proposedDepartureDate: Date;
  pricePerSeat: number;
  availableSeats: number;
  message: string | null;
  requiresPassengerKyc: boolean;
  departureReference: string | null;
  departureCoordinates: [number, number] | null;
  arrivalReference: string | null;
  arrivalCoordinates: [number, number] | null;
  status: DriverOfferStatus;
  createdAt: Date;
}

export interface SanitizedDriverOfferWithTripRequest extends SanitizedDriverOffer {
  tripRequest: {
    id: string;
    departureLocation: string;
    departureReference: string | null;
    arrivalLocation: string;
    arrivalReference: string | null;
    departureDateMin: Date;
    departureDateMax: Date;
    numberOfSeats: number;
    maxPricePerSeat: number | null;
    vehicleType: VehicleType;
    paymentMode: TripPaymentMode;
    status: TripRequestStatus;
    passenger: SanitizedUser;
  };
}

export interface SanitizedTripRequest {
  immediateDispatch: boolean;
  id: string;
  passenger: SanitizedUser;
  departureLocation: string;
  departureReference: string | null;
  arrivalLocation: string;
  arrivalReference: string | null;
  departureCoordinates: [number, number] | null;
  arrivalCoordinates: [number, number] | null;
  departureDateMin: Date;
  departureDateMax: Date;
  numberOfSeats: number;
  maxPricePerSeat: number | null;
  vehicleType: VehicleType;
  paymentMode: TripPaymentMode;
  description: string | null;
  status: TripRequestStatus;
  selectedDriver: SanitizedUser | null;
  selectedVehicle: SanitizedVehicle | null;
  selectedPricePerSeat: number | null;
  selectedDriverRequiresPassengerKyc: boolean;
  selectedAt: Date | null;
  tripId: string | null;
  driverPickupOverdueNotifiedAt: Date | null;
  driverOffers: SanitizedDriverOffer[];
  createdAt: Date;
  updatedAt: Date;
}

export interface TripRequestPriceRecommendation {
  currency: 'CDF';
  vehicleType: VehicleType;
  pricingModel: 'distance_per_vehicle_type';
  baseDistanceKm: number;
  additionalPricePerKmPerPassenger: number;
  distanceMeters: number | null;
  numberOfSeats: number;
  pricePerKmPerPassenger: number;
  recommendedPricePerSeat: number | null;
  recommendedTotalPrice: number | null;
  weatherImpact: WeatherRouteImpact;
}

export interface TripRequestVehiclePriceOption {
  vehicleType: VehicleType;
  displayName: string;
  maximumSeats: number | null;
  availableForRequestedSeats: boolean;
  pricePerKmPerPassenger: number;
  recommendedPricePerSeat: number | null;
  recommendedTotalPrice: number | null;
}

export interface TripRequestVehicleOptionsResponse {
  currency: 'CDF';
  pricingModel: 'distance_per_vehicle_type';
  distanceMeters: number | null;
  numberOfSeats: number;
  weatherImpact: WeatherRouteImpact;
  options: TripRequestVehiclePriceOption[];
}

@Injectable()
export class TripRequestsService {
  private readonly logger = new Logger(TripRequestsService.name);
  private readonly MAX_SEATS_WITHOUT_APPROVED_KYC = 2;
  private readonly UNACCEPTED_REQUEST_EXPIRATION_MS = UNACCEPTED_REQUEST_EXPIRATION_MS;
  private readonly ACCEPTED_REQUEST_EXPIRATION_MS = ACCEPTED_REQUEST_EXPIRATION_MS;
  private readonly EXPIRATION_WARNING_MS = 30 * 60 * 1000;
  private readonly RECOMMENDED_PRICE_PER_KM_PER_PASSENGER_BY_VEHICLE_TYPE: Record<
    VehicleType,
    number
  > = {
    [VehicleType.CAR]: 500,
    [VehicleType.MOTORCYCLE_TWO_WHEELS]: 1000,
    [VehicleType.MOTORCYCLE_THREE_WHEELS]: 1000,
  };
  private readonly VEHICLE_TYPE_DISPLAY_NAMES: Record<VehicleType, string> = {
    [VehicleType.CAR]: 'Voiture',
    [VehicleType.MOTORCYCLE_TWO_WHEELS]: 'Moto à 2 roues',
    [VehicleType.MOTORCYCLE_THREE_WHEELS]: 'Moto à 3 roues',
  };

  constructor(
    @InjectRepository(TripRequest)
    private tripRequestRepository: Repository<TripRequest>,
    @InjectRepository(DriverOffer)
    private driverOfferRepository: Repository<DriverOffer>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Vehicle)
    private vehicleRepository: Repository<Vehicle>,
    private fileUploadService: FileUploadService,
    private notificationService: NotificationService,
    private tripsService: TripsService,
    private bookingsService: BookingsService,
    private googleMapsService: GoogleMapsService,
    private subscriptionsService: SubscriptionsService,
    private weatherAwarenessService: WeatherAwarenessService,
    private tripRequestRecoveryService: TripRequestRecoveryService,
    private driverDispatch?: DriverDispatchService,
  ) {}

  async create(
    passengerId: string,
    createTripRequestDto: CreateTripRequestDto,
  ): Promise<SanitizedTripRequest> {
    this.logger.log(`Creating trip request for passenger: ${passengerId}`);

    const passenger = await this.userRepository.findOne({
      where: { id: passengerId },
      relations: ['kycDocuments'],
    });
    if (!passenger) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    const numberOfSeats = createTripRequestDto.numberOfSeats ?? 1;
    if (numberOfSeats < 1) {
      throw new BadRequestException('Le nombre de places doit être au moins 1');
    }

    this.ensurePassengerKycForExtraSeats(passenger, numberOfSeats);
    this.assertRequestedVehicleSeatCapacity(
      createTripRequestDto.vehicleType,
      numberOfSeats,
    );

    const {
      departureCoordinates,
      arrivalCoordinates,
      departureDateMin,
      departureDateMax,
      vehicleType,
      ...rest
    } = createTripRequestDto;

    // Validate dates
    const minDate = new Date(departureDateMin);
    const maxDate = new Date(departureDateMax);

    if (createTripRequestDto.immediateDispatch && (
        minDate.getTime() > Date.now() + 10 * 60 * 1000 || maxDate.getTime() > Date.now() + 60 * 60 * 1000)) {
      throw new BadRequestException('La recherche immédiate est réservée aux départs dans les prochaines minutes.');
    }

    if (minDate >= maxDate) {
      throw new BadRequestException(
        'La date de départ minimum doit être antérieure à la date maximum',
      );
    }

    if (minDate < new Date()) {
      throw new BadRequestException(
        'La date de départ minimum ne peut pas être dans le passé',
      );
    }

    const departurePoint = await this.resolvePointFromCoordinatesOrAddress(
      departureCoordinates,
      rest.departureLocation,
      rest.departureReference,
      'trip request departure',
    );
    const arrivalPoint = await this.resolvePointFromCoordinatesOrAddress(
      arrivalCoordinates,
      rest.arrivalLocation,
      rest.arrivalReference,
      'trip request arrival',
    );
    const recommendedPrice =
      rest.maxPricePerSeat ??
      (await this.calculateRecommendedPricePerSeat(
        departurePoint,
        arrivalPoint,
        vehicleType,
        'trip request creation',
      ));

    const tripRequest = this.tripRequestRepository.create({
      ...rest,
      immediateDispatch: Boolean(createTripRequestDto.immediateDispatch && this.driverDispatch?.enabled),
      paymentMode: rest.paymentMode ?? TripPaymentMode.CASH,
      maxPricePerSeat: recommendedPrice,
      vehicleType,
      numberOfSeats,
      passengerId,
      departurePoint,
      arrivalPoint,
      departureDateMin: minDate,
      departureDateMax: maxDate,
    });

    const saved = await this.tripRequestRepository.save(tripRequest);
    this.logger.log(`Trip request created: ${saved.id}`);

    // Immediate invitations broadcast accept/decline offers (first acceptance wins). A scheduled
    // nearby alert only opens the existing request; it does not reserve the driver.
    if (saved.immediateDispatch) void this.driverDispatch?.tick();
    else {
      let nearbyAlertQueued = false;
      if (this.driverDispatch?.enabled) {
        try { nearbyAlertQueued = await this.driverDispatch.notifyScheduledRequest(saved.id); }
        catch { this.logger.warn('Nearby scheduled-request alert deferred to the dispatch worker.'); }
      }
      // When geographic dispatch is enabled, its cron continues the bounded
      // broadcast. Never fall back to drivers with no recent position/outside 5 km.
      if (!nearbyAlertQueued && !this.driverDispatch?.enabled) await this.notifyDriversAboutTripRequest(saved);
    }

    return this.findOne(saved.id, passengerId);
  }

  async recommendPrice(
    payload: RecommendTripRequestPriceDto,
  ): Promise<TripRequestPriceRecommendation> {
    const numberOfSeats = payload.numberOfSeats ?? 1;
    const vehicleType = payload.vehicleType ?? VehicleType.CAR;

    if (numberOfSeats < 1) {
      throw new BadRequestException('Le nombre de places doit être au moins 1');
    }

    const departurePoint = await this.resolvePointFromCoordinatesOrAddress(
      payload.departureCoordinates,
      payload.departureLocation,
      payload.departureReference,
      'trip request price departure',
    );
    const arrivalPoint = await this.resolvePointFromCoordinatesOrAddress(
      payload.arrivalCoordinates,
      payload.arrivalLocation,
      payload.arrivalReference,
      'trip request price arrival',
    );
    const distanceMeters = await this.calculateRouteDistanceMeters(
      departurePoint,
      arrivalPoint,
      'trip request price recommendation',
    );
    const weatherImpact = await this.weatherAwarenessService.getRouteImpact(
      this.pointToCoordinates(departurePoint),
      this.pointToCoordinates(arrivalPoint),
    );
    const recommendedPricePerSeat = this.buildRecommendedPricePerSeat(
      distanceMeters,
      vehicleType,
      weatherImpact.priceMultiplier,
    );
    const pricePerKmPerPassenger =
      this.getRecommendedPricePerKmPerPassenger(vehicleType);

    return {
      currency: 'CDF',
      vehicleType,
      pricingModel: 'distance_per_vehicle_type',
      baseDistanceKm: 0,
      additionalPricePerKmPerPassenger: pricePerKmPerPassenger,
      distanceMeters,
      numberOfSeats,
      pricePerKmPerPassenger,
      recommendedPricePerSeat,
      recommendedTotalPrice:
        recommendedPricePerSeat === null
          ? null
          : recommendedPricePerSeat * numberOfSeats,
      weatherImpact,
    };
  }

  async getVehicleOptions(
    payload: TripRequestVehicleOptionsDto,
  ): Promise<TripRequestVehicleOptionsResponse> {
    const numberOfSeats = payload.numberOfSeats ?? 1;
    if (numberOfSeats < 1) {
      throw new BadRequestException('Le nombre de places doit être au moins 1');
    }

    const departurePoint = await this.resolvePointFromCoordinatesOrAddress(
      payload.departureCoordinates,
      payload.departureLocation,
      payload.departureReference,
      'trip request vehicle options departure',
    );
    const arrivalPoint = await this.resolvePointFromCoordinatesOrAddress(
      payload.arrivalCoordinates,
      payload.arrivalLocation,
      payload.arrivalReference,
      'trip request vehicle options arrival',
    );
    const distanceMeters = await this.calculateRouteDistanceMeters(
      departurePoint,
      arrivalPoint,
      'trip request vehicle options',
    );
    const weatherImpact = await this.weatherAwarenessService.getRouteImpact(
      this.pointToCoordinates(departurePoint),
      this.pointToCoordinates(arrivalPoint),
    );

    const options = Object.values(VehicleType).map((vehicleType) => {
      const maximumSeats = getVehicleMaxSeats(vehicleType);
      const recommendedPricePerSeat = this.buildRecommendedPricePerSeat(
        distanceMeters,
        vehicleType,
        weatherImpact.priceMultiplier,
      );

      return {
        vehicleType,
        displayName: this.VEHICLE_TYPE_DISPLAY_NAMES[vehicleType],
        maximumSeats,
        availableForRequestedSeats:
          maximumSeats === null || numberOfSeats <= maximumSeats,
        pricePerKmPerPassenger:
          this.getRecommendedPricePerKmPerPassenger(vehicleType),
        recommendedPricePerSeat,
        recommendedTotalPrice:
          recommendedPricePerSeat === null
            ? null
            : recommendedPricePerSeat * numberOfSeats,
      };
    });

    return {
      currency: 'CDF',
      pricingModel: 'distance_per_vehicle_type',
      distanceMeters,
      numberOfSeats,
      weatherImpact,
      options,
    };
  }

  async update(
    passengerId: string,
    tripRequestId: string,
    updateTripRequestDto: UpdateTripRequestDto,
    adminId?: string,
  ): Promise<SanitizedTripRequest> {
    this.logger.log(
      `Updating trip request ${tripRequestId} by passenger ${passengerId}`,
    );

    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId, passengerId },
      relations: ['driverOffers'],
    });

    if (!tripRequest) {
      this.logger.warn(
        `Trip request update failed: Trip request ${tripRequestId} not found for passenger ${passengerId}`,
      );
      throw new NotFoundException(
        "Commande de trajet non trouvée ou vous n'êtes pas le propriétaire",
      );
    }

    const reopening = tripRequest.status === TripRequestStatus.EXPIRED || this.shouldExpireRequest(tripRequest, new Date());
    if (reopening && (!updateTripRequestDto.departureDateMin || !updateTripRequestDto.departureDateMax ||
      new Date(updateTripRequestDto.departureDateMin).getTime() <= Date.now())) {
      throw new BadRequestException('Pour reprogrammer cette commande expirée, choisissez un nouveau créneau dans le futur.');
    }

    // Editing/reopening never changes an existing driver or trip assignment.
    if (tripRequest.status === TripRequestStatus.DRIVER_SELECTED || tripRequest.selectedDriverId || tripRequest.tripId) {
      this.logger.warn(
        `Trip request update failed: Driver already selected for trip request ${tripRequestId}`,
      );
      throw new BadRequestException(
        'Vous ne pouvez pas modifier une commande pour laquelle un driver a été sélectionné',
      );
    }

    if (
      tripRequest.status === TripRequestStatus.CANCELLED
    ) {
      this.logger.warn(
        `Trip request update failed: Trip request ${tripRequestId} is ${tripRequest.status}`,
      );
      throw new BadRequestException(
        'Vous ne pouvez pas modifier une commande annulée',
      );
    }

    // Check if any offer has been accepted
    const hasAcceptedOffer = tripRequest.driverOffers?.some(
      (offer) => offer.status === DriverOfferStatus.ACCEPTED,
    );

    if (hasAcceptedOffer) {
      this.logger.warn(
        `Trip request update failed: An offer has been accepted for trip request ${tripRequestId}`,
      );
      throw new BadRequestException(
        'Vous ne pouvez pas modifier une commande pour laquelle une offre a été acceptée',
      );
    }

    const snapshot = { ...tripRequest };
    for (const field of ['departureLocation', 'arrivalLocation', 'departureDateMin', 'departureDateMax', 'numberOfSeats', 'vehicleType', 'paymentMode'] as const) {
      if (updateTripRequestDto[field] === null)
        throw new BadRequestException(`Le champ ${field} ne peut pas être null.`);
    }
    for (const field of ['departureLocation', 'arrivalLocation'] as const) {
      if (updateTripRequestDto[field] !== undefined && !updateTripRequestDto[field]!.trim())
        throw new BadRequestException('Indiquez une adresse de départ et une adresse d’arrivée.');
    }
    if (updateTripRequestDto.expectedUpdatedAt &&
        new Date(updateTripRequestDto.expectedUpdatedAt).getTime() !== new Date(snapshot.updatedAt).getTime()) {
      throw new ConflictException('La commande a changé depuis son ouverture. Actualisez-la avant de réessayer.');
    }
    const {
      departureCoordinates,
      arrivalCoordinates,
      departureDateMin,
      departureDateMax,
      vehicleType,
    } = updateTripRequestDto;

    const resultingNumberOfSeats =
      updateTripRequestDto.numberOfSeats ?? tripRequest.numberOfSeats;
    const resultingVehicleType = vehicleType ?? tripRequest.vehicleType;
    if (!Number.isInteger(resultingNumberOfSeats) || resultingNumberOfSeats < 1 || updateTripRequestDto.numberOfSeats === null) {
      throw new BadRequestException('Le nombre de places doit être au moins 1');
    }
    await this.ensurePassengerKycForExtraSeatsById(
      passengerId,
      resultingNumberOfSeats,
    );
    this.assertRequestedVehicleSeatCapacity(
      resultingVehicleType,
      resultingNumberOfSeats,
    );

    // Update departure location and coordinates if provided
    if (updateTripRequestDto.departureLocation !== undefined) {
      tripRequest.departureLocation = updateTripRequestDto.departureLocation;
    }

    if (updateTripRequestDto.departureReference !== undefined) {
      tripRequest.departureReference =
        updateTripRequestDto.departureReference?.trim() || null;
    }

    const shouldRefreshDeparturePoint =
      updateTripRequestDto.departureLocation !== undefined ||
      updateTripRequestDto.departureReference !== undefined;

    if (departureCoordinates || shouldRefreshDeparturePoint) {
      tripRequest.departurePoint =
        await this.resolvePointFromCoordinatesOrAddress(
          departureCoordinates,
          tripRequest.departureLocation,
          tripRequest.departureReference,
          'trip request departure',
        );
    }

    // Update arrival location and coordinates if provided
    if (updateTripRequestDto.arrivalLocation !== undefined) {
      tripRequest.arrivalLocation = updateTripRequestDto.arrivalLocation;
    }

    if (updateTripRequestDto.arrivalReference !== undefined) {
      tripRequest.arrivalReference =
        updateTripRequestDto.arrivalReference?.trim() || null;
    }

    const shouldRefreshArrivalPoint =
      updateTripRequestDto.arrivalLocation !== undefined ||
      updateTripRequestDto.arrivalReference !== undefined;

    if (arrivalCoordinates || shouldRefreshArrivalPoint) {
      tripRequest.arrivalPoint =
        await this.resolvePointFromCoordinatesOrAddress(
          arrivalCoordinates,
          tripRequest.arrivalLocation,
          tripRequest.arrivalReference,
          'trip request arrival',
        );
    }

    // Update dates if provided
    if (departureDateMin || departureDateMax) {
      const minDate = departureDateMin
        ? new Date(departureDateMin)
        : tripRequest.departureDateMin;
      const maxDate = departureDateMax
        ? new Date(departureDateMax)
        : tripRequest.departureDateMax;

      // Validate dates
      if (!Number.isFinite(minDate.getTime()) || !Number.isFinite(maxDate.getTime()) || minDate >= maxDate) {
        throw new BadRequestException(
          'La date de départ minimum doit être antérieure à la date maximum',
        );
      }

      if (minDate.getTime() !== snapshot.departureDateMin.getTime() && minDate < new Date()) {
        throw new BadRequestException(
          'La date de départ minimum ne peut pas être dans le passé',
        );
      }

      tripRequest.departureDateMin = minDate;
      tripRequest.departureDateMax = maxDate;
    }

    // Update other fields
    if (updateTripRequestDto.numberOfSeats !== undefined) {
      tripRequest.numberOfSeats = updateTripRequestDto.numberOfSeats;
    }

    // A saved budget is the passenger's confirmed price, not a live estimate.
    // Route, reference and vehicle changes must never silently replace it.
    if (updateTripRequestDto.maxPricePerSeat != null) {
      tripRequest.maxPricePerSeat = updateTripRequestDto.maxPricePerSeat;
    }

    if (vehicleType !== undefined) {
      tripRequest.vehicleType = vehicleType;
    }

    if (updateTripRequestDto.paymentMode !== undefined) {
      tripRequest.paymentMode = updateTripRequestDto.paymentMode;
    }

    if (updateTripRequestDto.description !== undefined) {
      tripRequest.description = updateTripRequestDto.description;
    }

    // Persist only editable fields: never write a stale status/assignment snapshot.
    const editable = ['departureLocation', 'departureReference', 'departurePoint',
      'arrivalLocation', 'arrivalReference', 'arrivalPoint', 'departureDateMin', 'departureDateMax',
      'numberOfSeats', 'maxPricePerSeat', 'vehicleType', 'paymentMode', 'description'] as const;
    const patch: Partial<Pick<TripRequest, typeof editable[number] | 'immediateDispatch' | 'expirationNotificationSent'>> = {};
    for (const field of editable) {
      if (JSON.stringify(tripRequest[field]) !== JSON.stringify(snapshot[field]))
        Object.assign(patch, { [field]: tripRequest[field] });
    }
    if (!Object.keys(patch).length && !reopening) return this.findOne(tripRequestId, passengerId);
    // Rescheduling a proximity search outside its immediate horizon makes it a classic request.
    if (tripRequest.immediateDispatch && (reopening || tripRequest.departureDateMin.getTime() > Date.now() + 10 * 60_000 ||
      tripRequest.departureDateMax.getTime() > Date.now() + 60 * 60_000)) patch.immediateDispatch = false;
    if (reopening || patch.departureDateMax) patch.expirationNotificationSent = false;
    await this.tripRequestRepository.manager.transaction(async (manager) => {
      const requests = manager.getRepository(TripRequest);
      const current = await requests.findOne({ where: { id: tripRequestId }, lock: { mode: 'pessimistic_write' } });
      assertRequestSnapshot(current, snapshot);
      assertUnassignedRequest(current!, Date.now(), true);
      // Trip creation may have committed before the request's tripId is filled.
      const linked = await manager.getRepository(Trip).exists({ where: {
        tripRequestId, status: In([TripStatus.PENDING, TripStatus.ACTIVE, TripStatus.COMPLETED]),
      } });
      const offers = manager.getRepository(DriverOffer);
      if (linked || await offers.exists({ where: { tripRequestId, status: DriverOfferStatus.ACCEPTED } }))
        throw new ConflictException('Une prise en charge existe déjà pour cette commande.');
      // Validate the resulting schedule too: an edit cannot create an expired request.
      assertUnassignedRequest({ ...current!, ...patch, status: TripRequestStatus.PENDING });
      await offers.update({ tripRequestId, status: DriverOfferStatus.PENDING },
        { status: DriverOfferStatus.REJECTED, rejectedAt: new Date() });
      if (current!.immediateDispatch) {
        await manager.createQueryBuilder().update('trip_request_dispatch_offers')
          .set({ status: 'cancelled' }).where('"requestId" = :id AND status = :status',
            { id: tripRequestId, status: 'pending' }).execute();
      }
      await requests.update(tripRequestId, { ...patch, id: tripRequestId, status: TripRequestStatus.PENDING });
    });
    this.logger.log(`Trip request updated: ${tripRequestId}${adminId ? ` by admin ${adminId}` : ''}`);
    if (tripRequest.immediateDispatch && patch.immediateDispatch !== false) void this.driverDispatch?.tick();
    return this.findOne(tripRequestId, passengerId);
  }

  private async notifyDriversAboutTripRequest(
    tripRequest: TripRequest,
  ): Promise<void> {
    try {
      // Get all active drivers with FCM tokens, excluding the passenger who created the request
      const drivers = await this.userRepository.find({
        where: {
          role: UserRole.DRIVER,
          isActive: true,
        },
        select: ['id', 'fcmToken', 'firstName'],
      });

      // Filter drivers: exclude the passenger who created the trip request and keep only those with valid FCM tokens
      const driversWithTokens = drivers.filter(
        (driver) => driver.fcmToken && driver.id !== tripRequest.passengerId,
      );

      if (driversWithTokens.length === 0) {
        this.logger.debug(
          'No drivers with FCM tokens found (excluding passenger), skipping notifications',
        );
        return;
      }

      const fcmTokens = driversWithTokens.map((driver) => driver.fcmToken!);
      const driverIds = driversWithTokens.map((driver) => driver.id);

      const title = 'Nouvelle commande de trajet disponible';
      const body =
        'Un passager cherche un trajet. Consultez la commande pour voir les points de départ et d’arrivée.';

      const data = {
        type: 'trip_request',
        tripRequestId: tripRequest.id,
        passengerId: tripRequest.passengerId,
        departureLocation: 'Point de départ',
        arrivalLocation: 'Point d’arrivée',
        numberOfSeats: tripRequest.numberOfSeats.toString(),
        vehicleType: tripRequest.vehicleType ?? VehicleType.CAR,
        maxPricePerSeat: Number(tripRequest.maxPricePerSeat ?? 0).toString(),
        departureDateMin: tripRequest.departureDateMin.toISOString(),
        departureDateMax: tripRequest.departureDateMax.toISOString(),
      };

      await this.notificationService.sendToMultiple(
        fcmTokens,
        title,
        body,
        data,
        driverIds,
      );
      this.logger.log(
        `Notified ${fcmTokens.length} drivers about trip request ${tripRequest.id} (excluded passenger ${tripRequest.passengerId})`,
      );
    } catch (error) {
      this.logger.error(
        `Error notifying drivers about trip request ${tripRequest.id}: ${error.message}`,
        error.stack,
      );
      // Don't throw error, just log it - trip request creation should succeed even if notification fails
    }
  }

  async findAll(driverId: string): Promise<SanitizedTripRequest[]> {
    await this.assertDriverViewer(driverId);
    this.logger.debug('Fetching all trip requests');

    // Search/Home still use this legacy endpoint. Filter elapsed deadlines in
    // SQL, independently of the cron or a successful status update on a read.
    const tripRequests = await this.tripRequestRepository.find({
      relations: [
        'passenger',
        'selectedDriver',
        'selectedVehicle',
        'driverOffers',
        'driverOffers.driver',
        'driverOffers.vehicle',
      ],
      where: {
        status: In([
          TripRequestStatus.PENDING,
          TripRequestStatus.OFFERS_RECEIVED,
        ]),
        departureDateMax: MoreThan(new Date(Date.now() - this.UNACCEPTED_REQUEST_EXPIRATION_MS)),
        immediateDispatch: false,
        selectedDriverId: IsNull(),
        tripId: IsNull(),
      },
      order: { createdAt: 'DESC' },
    });

    await this.expireRequests(tripRequests);

    // Recheck the deadline after hydration, including a raced expiration update
    // that affected zero rows and therefore left this snapshot unchanged.
    const now = new Date();
    const visibleTripRequests = tripRequests.filter(
      (tr) => this.isAvailableRequest(tr, now),
    );

    return Promise.all(
      visibleTripRequests.map((tr) =>
        this.sanitizeTripRequest(tr, driverId, true),
      ),
    );
  }

  async findRequestPage(userId: string, own: boolean, options: HistoryPageQuery) {
    if (!own) await this.assertDriverViewer(userId);
    const page = await requestPageIds(this.tripRequestRepository, userId, own, options);
    if (!page.ids.length) return { data: [], total: page.total, nextCursor: page.nextCursor };
    const requests = await this.tripRequestRepository.find({ where: { id: In(page.ids) },
      relations: ['passenger', 'selectedDriver', 'selectedVehicle', 'driverOffers', 'driverOffers.driver', 'driverOffers.vehicle'] });
    await this.expireRequests(requests);
    // Recheck after hydration: an acceptance/cancellation can race the ID page.
    const now = new Date();
    const visible = orderHistory(page.ids, requests).filter(request => own
      ? request.passengerId === userId
      : this.isAvailableRequest(request, now));
    return { data: await Promise.all(visible.map(request => this.sanitizeTripRequest(request, userId, !own))),
      total: page.total, nextCursor: page.nextCursor };
  }

  async findOfferPage(driverId: string, options: HistoryPageQuery) {
    await this.assertDriverViewer(driverId);
    const page = await offerPageIds(this.driverOfferRepository, driverId, options);
    const offers = page.ids.length ? await this.driverOfferRepository.find({
      where: { id: In(page.ids), driverId }, relations: ['driver', 'vehicle', 'tripRequest', 'tripRequest.passenger'],
    }) : [];
    return { data: await Promise.all(orderHistory(page.ids, offers).map(offer => this.sanitizeDriverOfferWithTripRequest(offer, driverId))),
      total: page.total, nextCursor: page.nextCursor };
  }

  async findOne(id: string, userId?: string): Promise<SanitizedTripRequest> {
    this.logger.debug(`Fetching trip request: ${id}`);

    if (!userId) {
      throw new NotFoundException('Commande de trajet non trouvée');
    }

    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id },
      relations: [
        'passenger',
        'selectedDriver',
        'selectedVehicle',
        'driverOffers',
        'driverOffers.driver',
        'driverOffers.vehicle',
      ],
    });

    if (!tripRequest) {
      throw new NotFoundException('Commande de trajet non trouvée');
    }

    await this.expireRequests([tripRequest]);

    const isPassenger = tripRequest.passengerId === userId;
    if (!isPassenger) {
      if (this.hasAcceptedDriver(tripRequest)) {
        if (this.getSelectedDriverId(tripRequest) !== userId) {
          throw new NotFoundException('Commande de trajet non trouvée');
        }
      } else if (
        tripRequest.status !== TripRequestStatus.PENDING &&
        tripRequest.status !== TripRequestStatus.OFFERS_RECEIVED
      ) {
        throw new NotFoundException('Commande de trajet non trouvée');
      }
      await this.assertDriverViewer(userId);
    }

    return this.sanitizeTripRequest(tripRequest, userId);
  }

  async getOffersForTripRequest(
    tripRequestId: string,
    userId?: string,
  ): Promise<SanitizedDriverOffer[]> {
    this.logger.debug(`Fetching offers for trip request: ${tripRequestId}`);

    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId },
      relations: [
        'driverOffers',
        'driverOffers.driver',
        'driverOffers.vehicle',
      ],
    });

    if (!tripRequest) {
      throw new NotFoundException('Commande de trajet non trouvée');
    }

    // Only passenger can see all offers
    if (!userId || tripRequest.passengerId !== userId) {
      throw new ForbiddenException(
        'Seul le passager peut voir toutes les offres',
      );
    }

    if (!tripRequest.driverOffers || tripRequest.driverOffers.length === 0) {
      return [];
    }

    return Promise.all(
      tripRequest.driverOffers.map((offer) =>
        this.sanitizeDriverOffer(offer, tripRequest, userId),
      ),
    );
  }

  async findByPassenger(passengerId: string, activityOnly = false): Promise<SanitizedTripRequest[]> {
    this.logger.debug(`Fetching trip requests for passenger: ${passengerId}`);

    const tripRequests = await this.tripRequestRepository.find({
      where: activityOnly ? activeRequestWhere(passengerId) : { passengerId },
      relations: [
        'passenger',
        'selectedDriver',
        'selectedVehicle',
        'driverOffers',
        'driverOffers.driver',
        'driverOffers.vehicle',
      ],
      order: { createdAt: 'DESC' },
    });

    await this.expireRequests(tripRequests);

    return Promise.all(
      tripRequests.map((tr) => this.sanitizeTripRequest(tr, passengerId)),
    );
  }

  async findByDriver(
    driverId: string,
  ): Promise<SanitizedDriverOfferWithTripRequest[]> {
    await this.assertDriverViewer(driverId);
    this.logger.debug(`Fetching driver offers for driver: ${driverId}`);

    const offers = await this.driverOfferRepository.find({
      where: { driverId },
      relations: ['driver', 'vehicle', 'tripRequest', 'tripRequest.passenger'],
      order: { createdAt: 'DESC' },
    });

    return Promise.all(
      offers.map((offer) =>
        this.sanitizeDriverOfferWithTripRequest(offer, driverId),
      ),
    );
  }

  async createDriverOffer(
    driverId: string,
    tripRequestId: string,
    createDriverOfferDto: CreateDriverOfferDto,
  ): Promise<SanitizedDriverOffer> {
    this.logger.log(
      `Creating driver offer for trip request: ${tripRequestId} by driver: ${driverId}`,
    );

    const driver = await this.userRepository.findOne({
      where: { id: driverId },
    });
    if (!driver) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    await assertDriverCanOperate(this.userRepository.manager, driver);

    if (await this.tripRequestRepository.manager.getRepository(Trip).exists({
      where: { driverId, status: TripStatus.ACTIVE },
    })) throw new ConflictException({ code: 'SHARED_TRIP_OFFER_REQUIRED',
      message: 'Vous avez un trajet en cours. Proposez au passager de le partager ; son accord est nécessaire.' });

    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId },
      relations: ['passenger', 'driverOffers'],
    });

    if (!tripRequest) {
      throw new NotFoundException('Commande de trajet non trouvée');
    }

    await this.expireRequests([tripRequest]);

    if (tripRequest.immediateDispatch) {
      throw new BadRequestException('Répondez à la proposition de proximité qui vous a été personnellement adressée.');
    }

    // Check if trip request status allows new offers
    if (tripRequest.status === TripRequestStatus.DRIVER_SELECTED) {
      throw new BadRequestException(
        "Cette commande de trajet n'accepte plus d'offres car un driver a déjà été sélectionné",
      );
    }

    if (
      tripRequest.status !== TripRequestStatus.PENDING &&
      tripRequest.status !== TripRequestStatus.OFFERS_RECEIVED
    ) {
      throw new BadRequestException(
        "Cette commande de trajet n'accepte plus d'offres",
      );
    }

    // Check if any offer has been accepted (double check even if status is not DRIVER_SELECTED yet)
    const hasAcceptedOffer = tripRequest.driverOffers?.some(
      (offer) => offer.status === DriverOfferStatus.ACCEPTED,
    );

    if (hasAcceptedOffer) {
      throw new BadRequestException(
        "Cette commande de trajet n'accepte plus d'offres car une offre a déjà été acceptée",
      );
    }

    if (tripRequest.passengerId === driverId) {
      throw new BadRequestException(
        'Vous ne pouvez pas faire une offre sur votre propre commande',
      );
    }

    // Check if driver already made an offer
    const existingOffer = await this.driverOfferRepository.findOne({
      where: {
        tripRequestId,
        driverId,
        status: DriverOfferStatus.PENDING,
      },
    });
    if (existingOffer) {
      throw new BadRequestException(
        'Vous avez déjà fait une offre pour cette commande',
      );
    }

    const {
      proposedDepartureDate,
      vehicleId,
      departureCoordinates,
      arrivalCoordinates,
      ...rest
    } = createDriverOfferDto;
    const proposedDate = new Date(proposedDepartureDate);

    // Validate proposed date is within the range
    if (
      proposedDate < tripRequest.departureDateMin ||
      proposedDate > tripRequest.departureDateMax
    ) {
      throw new BadRequestException(
        `La date proposée doit être entre ${tripRequest.departureDateMin.toISOString()} et ${tripRequest.departureDateMax.toISOString()}`,
      );
    }

    // Validate price if maxPricePerSeat is set
    if (
      tripRequest.maxPricePerSeat !== null &&
      createDriverOfferDto.pricePerSeat > tripRequest.maxPricePerSeat
    ) {
      throw new BadRequestException(
        `Le prix proposé (${createDriverOfferDto.pricePerSeat}) dépasse le prix maximum accepté (${tripRequest.maxPricePerSeat})`,
      );
    }

    // Validate seats
    if (createDriverOfferDto.availableSeats < tripRequest.numberOfSeats) {
      throw new BadRequestException(
        `Vous devez proposer au moins ${tripRequest.numberOfSeats} place(s)`,
      );
    }

    // Le véhicule proposé doit correspondre au choix enregistré par le passager.
    let vehicle: Vehicle | null = null;
    if (vehicleId) {
      vehicle = await this.vehicleRepository.findOne({
        where: { id: vehicleId, ownerId: driverId },
      });

      if (!vehicle) {
        throw new BadRequestException(
          'Véhicule non trouvé ou ne vous appartient pas',
        );
      }

      if (!vehicle.isActive) {
        throw new BadRequestException(
          "Le véhicule sélectionné n'est pas actif",
        );
      }

      this.assertVehicleSeatCapacity(
        vehicle,
        createDriverOfferDto.availableSeats,
      );
    } else {
      vehicle = await this.vehicleRepository.findOne({
        where: {
          ownerId: driverId,
          isActive: true,
          type: tripRequest.vehicleType ?? VehicleType.CAR,
        },
      });

      if (!vehicle) {
        throw new BadRequestException(
          `Vous devez sélectionner un véhicule actif de type ${this.VEHICLE_TYPE_DISPLAY_NAMES[tripRequest.vehicleType ?? VehicleType.CAR]}`,
        );
      }

      this.assertVehicleSeatCapacity(
        vehicle,
        createDriverOfferDto.availableSeats,
      );
    }

    this.assertVehicleMatchesTripRequest(vehicle, tripRequest);

    const offer = this.driverOfferRepository.create({
      ...rest,
      tripRequestId,
      driverId,
      vehicleId: vehicle.id,
      departurePoint:
        departureCoordinates || rest.departureReference
          ? await this.resolvePointFromCoordinatesOrAddress(
              departureCoordinates,
              tripRequest.departureLocation,
              rest.departureReference,
              'driver offer departure',
            )
          : null,
      arrivalPoint:
        arrivalCoordinates || rest.arrivalReference
          ? await this.resolvePointFromCoordinatesOrAddress(
              arrivalCoordinates,
              tripRequest.arrivalLocation,
              rest.arrivalReference,
              'driver offer arrival',
            )
          : null,
      proposedDepartureDate: proposedDate,
    });

    const saved = await this.tripRequestRepository.manager.transaction(async (manager) => {
      const requests = manager.getRepository(TripRequest);
      const current = await requests.findOne({ where: { id: tripRequestId }, lock: { mode: 'pessimistic_write' } });
      assertRequestSnapshot(current, tripRequest);
      assertUnassignedRequest(current!);
      const offers = manager.getRepository(DriverOffer);
      if (await offers.exists({ where: { tripRequestId, driverId, status: DriverOfferStatus.PENDING } }))
        throw new ConflictException('Vous avez déjà une offre en attente pour cette commande.');
      const result = await offers.save(offer);
      await requests.update(tripRequestId, { id: tripRequestId, status: TripRequestStatus.OFFERS_RECEIVED });
      return result;
    });

    this.logger.log(`Driver offer created: ${saved.id}`);

    const offerWithRelations = await this.driverOfferRepository.findOne({
      where: { id: saved.id },
      relations: ['driver', 'vehicle'],
    });

    // Notify the passenger about the new driver offer
    await this.notifyPassengerAboutDriverOffer(
      tripRequest,
      offerWithRelations!,
    );

    return this.sanitizeDriverOffer(offerWithRelations!, tripRequest, driverId);
  }

  private async notifyPassengerAboutDriverOffer(
    tripRequest: TripRequest,
    offer: DriverOffer,
  ): Promise<void> {
    try {
      // Get the passenger with FCM token
      const passenger = await this.userRepository.findOne({
        where: { id: tripRequest.passengerId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!passenger || !passenger.fcmToken) {
        this.logger.debug(
          `Passenger ${tripRequest.passengerId} has no FCM token, skipping notification`,
        );
        return;
      }

      const driverName = offer.driver
        ? `${offer.driver.firstName} ${offer.driver.lastName}`
        : 'Un conducteur';
      const title = 'Nouvelle offre reçue';
      const body = `${driverName} a fait une offre pour votre commande de trajet de ${tripRequest.departureLocation} à ${tripRequest.arrivalLocation}`;

      const data = {
        type: 'driver_offer',
        tripRequestId: tripRequest.id,
        offerId: offer.id,
        driverId: offer.driverId,
        pricePerSeat: offer.pricePerSeat.toString(),
        proposedDepartureDate: offer.proposedDepartureDate.toISOString(),
        requiresPassengerKyc: offer.requiresPassengerKyc ? 'true' : 'false',
      };

      await this.notificationService.sendNotification(
        passenger.fcmToken,
        title,
        body,
        data,
        tripRequest.passengerId,
      );
      this.logger.log(
        `Notified passenger ${tripRequest.passengerId} about driver offer ${offer.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Error notifying passenger about driver offer ${offer.id}: ${error.message}`,
        error.stack,
      );
      // Don't throw error, just log it - offer creation should succeed even if notification fails
    }
  }

  private async notifyDriverAboutOfferAcceptance(
    tripRequest: TripRequest,
    offer: DriverOffer,
  ): Promise<void> {
    try {
      // Get the driver with FCM token
      const driver = await this.userRepository.findOne({
        where: { id: offer.driverId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!driver || !driver.fcmToken) {
        this.logger.debug(
          `Driver ${offer.driverId} has no FCM token, skipping notification`,
        );
        return;
      }

      const passengerName = tripRequest.passenger
        ? `${tripRequest.passenger.firstName} ${tripRequest.passenger.lastName}`
        : 'Un passager';
      const title = '✅ Offre acceptée';
      const body = `${passengerName} a accepté votre offre pour le trajet de ${tripRequest.departureLocation} à ${tripRequest.arrivalLocation}. Vous pouvez maintenant démarrer le trajet.`;

      const data = {
        type: 'offer_accepted',
        tripRequestId: tripRequest.id,
        offerId: offer.id,
        passengerId: tripRequest.passengerId,
        departureLocation: tripRequest.departureLocation,
        arrivalLocation: tripRequest.arrivalLocation,
        proposedDepartureDate: offer.proposedDepartureDate.toISOString(),
      };

      await this.notificationService.sendNotification(
        driver.fcmToken,
        title,
        body,
        data,
        offer.driverId,
      );
      this.logger.log(
        `Notified driver ${offer.driverId} about offer acceptance ${offer.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Error notifying driver about offer acceptance ${offer.id}: ${error.message}`,
        error.stack,
      );
      // Don't throw error, just log it - offer acceptance should succeed even if notification fails
    }
  }

  async acceptDriverOffer(
    passengerId: string,
    tripRequestId: string,
    acceptDto: AcceptDriverOfferDto,
  ): Promise<SanitizedTripRequest> {
    this.logger.log(
      `Accepting driver offer ${acceptDto.offerId} for trip request ${tripRequestId} by passenger ${passengerId}`,
    );

    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId, passengerId },
      relations: [
        'passenger',
        'driverOffers',
        'driverOffers.driver',
        'driverOffers.vehicle',
      ],
    });

    if (!tripRequest) {
      throw new NotFoundException(
        "Commande de trajet non trouvée ou vous n'êtes pas le propriétaire",
      );
    }

    await this.expireRequests([tripRequest]);

    if (tripRequest.status === TripRequestStatus.DRIVER_SELECTED) {
      throw new BadRequestException(
        'Un driver a déjà été sélectionné pour cette commande',
      );
    }

    if (
      tripRequest.status === TripRequestStatus.CANCELLED ||
      tripRequest.status === TripRequestStatus.EXPIRED
    ) {
      throw new BadRequestException("Cette commande n'accepte plus d'offres");
    }

    if (tripRequest.immediateDispatch) {
      throw new BadRequestException('La sélection du conducteur est gérée par la recherche de proximité.');
    }
    const offer = tripRequest.driverOffers?.find(
      (o) => o.id === acceptDto.offerId,
    );
    if (!offer) {
      throw new NotFoundException('Offre du conducteur non trouvée');
    }

    if (offer.existingTripId) throw new BadRequestException({
      code: 'SHARED_TRIP_CONSENT_REQUIRED',
      message: 'Confirmez explicitement le partage du trajet dans une version compatible de l’application.',
    });

    if (offer.status !== DriverOfferStatus.PENDING) {
      throw new BadRequestException("Cette offre n'est plus disponible");
    }

    if (!offer.vehicle) {
      throw new BadRequestException(
        'Cette offre ne contient pas de véhicule compatible avec la commande',
      );
    }
    this.assertVehicleMatchesTripRequest(offer.vehicle, tripRequest);

    if (offer.requiresPassengerKyc) {
      await this.ensurePassengerKycApprovedForDriverRequirement(passengerId, {
        tripRequestId,
        offerId: offer.id,
        driverId: offer.driverId,
        message:
          "Ce conducteur exige une vérification d'identité approuvée avant d'accepter son offre.",
      });
    }

    await this.tripRequestRepository.manager.transaction(async (manager) => {
      const requests = manager.getRepository(TripRequest);
      const current = await requests.findOne({ where: { id: tripRequestId }, lock: { mode: 'pessimistic_write' } });
      assertRequestSnapshot(current, tripRequest);
      assertUnassignedRequest(current!);
      if (await manager.getRepository(Trip).exists({ where: { driverId: offer.driverId, status: TripStatus.ACTIVE } }))
        throw new ConflictException({ code: 'SHARED_TRIP_OFFER_REQUIRED',
          message: 'Ce conducteur est maintenant en trajet. Il doit proposer un partage que vous pourrez accepter explicitement.' });
      if (await manager.getRepository(Trip).exists({ where: { tripRequestId,
        status: In([TripStatus.PENDING, TripStatus.ACTIVE, TripStatus.COMPLETED]) } }))
        throw new ConflictException('Une prise en charge existe déjà pour cette commande.');
      const offers = manager.getRepository(DriverOffer);
      const acceptedAt = new Date();
      const result = await offers.update({ id: offer.id, tripRequestId, status: DriverOfferStatus.PENDING },
        { status: DriverOfferStatus.ACCEPTED, acceptedAt });
      if (result.affected !== 1) throw new ConflictException('Cette offre a changé. Actualisez la commande.');
      await offers.update({ tripRequestId, status: DriverOfferStatus.PENDING },
        { status: DriverOfferStatus.REJECTED, rejectedAt: acceptedAt });
      await requests.update(tripRequestId, {
        id: tripRequestId,
        status: TripRequestStatus.DRIVER_SELECTED, selectedDriverId: offer.driverId,
        selectedVehicleId: offer.vehicleId, selectedPricePerSeat: offer.pricePerSeat,
        selectedDriverRequiresPassengerKyc: offer.requiresPassengerKyc,
        selectedAt: acceptedAt, driverPickupOverdueNotifiedAt: null,
      });
    });

    this.logger.log(
      `Driver offer ${acceptDto.offerId} accepted for trip request ${tripRequestId}`,
    );

    // Notify the driver that their offer was accepted
    await this.notifyDriverAboutOfferAcceptance(tripRequest, offer);

    return this.findOne(tripRequestId, passengerId);
  }

  async startTripFromRequest(tripRequestId: string, driverId: string) {
    this.logger.log(
      `Starting trip from request ${tripRequestId} by driver ${driverId}`,
    );

    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId },
      relations: ['passenger', 'selectedDriver', 'selectedVehicle'],
    });

    if (!tripRequest) {
      throw new NotFoundException('Commande de trajet non trouvée');
    }

    await this.expireRequests([tripRequest]);
    if (tripRequest.status === TripRequestStatus.EXPIRED) {
      throw new BadRequestException(
        'Cette commande a expiré. Créez une nouvelle commande pour organiser un autre départ.',
      );
    }

    if (tripRequest.status !== TripRequestStatus.DRIVER_SELECTED) {
      throw new BadRequestException(
        'Un driver doit être sélectionné avant de lancer le trajet',
      );
    }

    if (tripRequest.selectedDriverId !== driverId) {
      throw new ForbiddenException(
        "Vous n'êtes pas le driver sélectionné pour cette commande",
      );
    }

    if (tripRequest.tripId) {
      throw new BadRequestException(
        'Un trajet a déjà été créé à partir de cette commande !',
      );
    }

    await this.tripsService.ensureDriverCanStartTrip(driverId);

    // Get the accepted offer to get the proposed departure date
    const acceptedOffer = await this.driverOfferRepository.findOne({
      where: {
        tripRequestId,
        driverId,
        status: DriverOfferStatus.ACCEPTED,
      },
    });

    if (!acceptedOffer) {
      throw new NotFoundException('Offre acceptée non trouvée');
    }

    const requiresPassengerKyc =
      acceptedOffer.requiresPassengerKyc ||
      tripRequest.selectedDriverRequiresPassengerKyc;
    if (requiresPassengerKyc) {
      await this.ensurePassengerKycApprovedForDriverRequirement(
        tripRequest.passengerId,
        {
          tripRequestId,
          offerId: acceptedOffer.id,
          driverId,
          message:
            "Ce conducteur exige une vérification d'identité approuvée avant de démarrer ce trajet.",
        },
      );
    }

    const departureCoordinates =
      this.pointToCoordinates(acceptedOffer.departurePoint) ??
      this.pointToCoordinates(tripRequest.departurePoint);
    const arrivalCoordinates =
      this.pointToCoordinates(acceptedOffer.arrivalPoint) ??
      this.pointToCoordinates(tripRequest.arrivalPoint);

    // Create Trip from TripRequest (private by default)
    const trip = await this.tripsService.create(
      driverId,
      {
        departureLocation: tripRequest.departureLocation,
        departureReference:
          acceptedOffer.departureReference ||
          tripRequest.departureReference ||
          undefined,
        arrivalLocation: tripRequest.arrivalLocation,
        arrivalReference:
          acceptedOffer.arrivalReference ||
          tripRequest.arrivalReference ||
          undefined,
        departureCoordinates: departureCoordinates ?? undefined,
        arrivalCoordinates: arrivalCoordinates ?? undefined,
        departureDate: acceptedOffer.proposedDepartureDate.toISOString(),
        totalSeats: acceptedOffer.availableSeats,
        pricePerSeat: Number(tripRequest.selectedPricePerSeat ?? 0),
        isFree: Number(tripRequest.selectedPricePerSeat ?? 0) === 0,
        requiresPassengerKyc,
        vehicleId: tripRequest.selectedVehicleId || undefined,
        description: tripRequest.description || undefined,
      },
      {
        isPrivate: true, // Trajet privé par défaut
        tripRequestId: tripRequest.id,
      },
    );

    // Create booking for the passenger automatically (ACCEPTED status)
    try {
      await this.bookingsService.create(tripRequest.passengerId, {
        tripId: trip.id,
        numberOfSeats: tripRequest.numberOfSeats,
        passengerOrigin: tripRequest.departureLocation,
        passengerOriginReference: tripRequest.departureReference || undefined,
        passengerDestination: tripRequest.arrivalLocation,
        passengerDestinationReference: tripRequest.arrivalReference || undefined,
        paymentMode: tripRequest.paymentMode,
      });
    } catch (error) {
      // A failed booking must not leave an empty upcoming trip on the driver's Home.
      // A booking that actually committed (ambiguous response) is never cancelled here.
      try {
        await this.tripsService.cancelFailedRequestTrip(trip.id, driverId, tripRequest.id);
      } catch {
        this.logger.warn('Unable to cancel an empty request trip after booking failure');
      }
      throw error;
    }

    // Accept the booking automatically
    const bookings = await this.bookingsService.findAllByTrip(
      trip.id,
      driverId,
    );
    const passengerBooking = bookings.find(
      (b) => b.passengerId === tripRequest.passengerId,
    );
    if (passengerBooking) {
      await this.bookingsService.acceptBooking(passengerBooking.id, driverId);
    }

    // Update trip request with tripId
    tripRequest.tripId = trip.id;
    await this.tripRequestRepository.save(tripRequest);

    // Start the trip
    const startedTrip = await this.tripsService.startTrip(trip.id, driverId);

    this.logger.log(`Trip ${trip.id} started from request ${tripRequestId}`);

    return {
      trip: startedTrip,
      tripRequest: await this.findOne(tripRequestId, driverId),
    };
  }

  /**
   * Accept a trip request directly as a driver (Uber/Bolt/Yango style)
   * The driver sees the number of seats requested by the passenger and the maximum price accepted.
   * The driver accepts or refuses based on whether the request suits them.
   * The price used is the maximum price accepted by the passenger (maxPricePerSeat), or 0 if not specified.
   * Creates a trip and booking automatically with the passenger's requested number of seats.
   */
  async acceptTripRequest(
    driverId: string,
    tripRequestId: string,
    acceptDto: AcceptTripRequestDto,
  ): Promise<{ trip: any; tripRequest: SanitizedTripRequest }> {
    this.logger.log(
      `Driver ${driverId} accepte la commande de trajet ${tripRequestId}`,
    );
    if (await this.tripRequestRepository.manager.getRepository(Trip).exists({
      where: { driverId, status: TripStatus.ACTIVE },
    })) throw new ConflictException({ code: 'SHARED_TRIP_OFFER_REQUIRED',
      message: 'Vous avez un trajet en cours. Proposez son partage et attendez l’accord du passager.' });

    // Verify driver exists
    const driver = await this.userRepository.findOne({
      where: { id: driverId },
    });
    if (!driver) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    // Get trip request with relations
    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId },
      relations: ['passenger', 'driverOffers'],
    });

    if (!tripRequest) {
      throw new NotFoundException('Commande de trajet non trouvée');
    }

    await this.expireRequests([tripRequest]);

    if (tripRequest.immediateDispatch) {
      throw new BadRequestException('Répondez à votre proposition de proximité pour accepter cette commande.');
    }

    // Check if trip request can be accepted
    if (tripRequest.status === TripRequestStatus.DRIVER_SELECTED) {
      throw new BadRequestException(
        'Cette commande de trajet a déjà été acceptée par un autre driver',
      );
    }

    if (
      tripRequest.status === TripRequestStatus.CANCELLED ||
      tripRequest.status === TripRequestStatus.EXPIRED
    ) {
      throw new BadRequestException(
        "Cette commande de trajet n'est plus disponible",
      );
    }

    // Check if driver is not the passenger
    if (tripRequest.passengerId === driverId) {
      throw new BadRequestException(
        'Vous ne pouvez pas accepter votre propre commande',
      );
    }

    // Check if trip request already has a trip created
    if (tripRequest.tripId) {
      throw new BadRequestException(
        'Un trajet a déjà été créé à partir de cette commande',
      );
    }

    // Use the maximum price accepted by the passenger, or 0 (free trip) if not specified
    // The driver accepts the request as-is, without proposing a price
    const pricePerSeat = Number(tripRequest.maxPricePerSeat ?? 0);
    const requiresPassengerKyc = acceptDto.requiresPassengerKyc ?? false;

    if (requiresPassengerKyc) {
      await this.ensurePassengerKycApprovedForDriverRequirement(
        tripRequest.passengerId,
        {
          tripRequestId,
          driverId,
          message:
            "Ce conducteur exige une vérification d'identité approuvée avant d'accepter cette commande.",
        },
      );
    }

    // Determine total seats: use provided value or default to number of seats requested by passenger
    // The driver accepts the request with the number of seats requested by the passenger
    const totalSeats = acceptDto.totalSeats ?? tripRequest.numberOfSeats;

    // Validate that totalSeats is at least equal to the number of seats requested
    if (totalSeats < tripRequest.numberOfSeats) {
      throw new BadRequestException(
        `Le nombre de places doit être au moins égal au nombre de places demandées (${tripRequest.numberOfSeats})`,
      );
    }

    // Validate and get vehicle
    let vehicle: Vehicle | null = null;
    if (acceptDto.vehicleId) {
      vehicle = await this.vehicleRepository.findOne({
        where: { id: acceptDto.vehicleId, ownerId: driverId },
      });

      if (!vehicle) {
        throw new BadRequestException(
          'Véhicule non trouvé ou ne vous appartient pas',
        );
      }

      if (!vehicle.isActive) {
        throw new BadRequestException(
          "Le véhicule sélectionné n'est pas actif",
        );
      }
    } else {
      // Get first active vehicle if no vehicle specified
      vehicle = await this.vehicleRepository.findOne({
        where: {
          ownerId: driverId,
          isActive: true,
          type: tripRequest.vehicleType ?? VehicleType.CAR,
        },
      });

      if (!vehicle) {
        throw new BadRequestException(
          'Vous devez avoir au moins un véhicule actif pour accepter une commande',
        );
      }
    }

    this.assertVehicleMatchesTripRequest(vehicle, tripRequest);
    this.assertVehicleSeatCapacity(vehicle, totalSeats);

    // Determine departure date
    let departureDate: Date;
    if (acceptDto.departureDate) {
      departureDate = new Date(acceptDto.departureDate);
      // Validate date is within range
      if (
        departureDate < tripRequest.departureDateMin ||
        departureDate > tripRequest.departureDateMax
      ) {
        throw new BadRequestException(
          `La date de départ doit être entre ${tripRequest.departureDateMin.toISOString()} et ${tripRequest.departureDateMax.toISOString()}`,
        );
      }
    } else {
      // Use minimum departure date if not specified
      departureDate = tripRequest.departureDateMin;
    }

    const departureCoordinates =
      acceptDto.departureCoordinates ??
      this.pointToCoordinates(tripRequest.departurePoint);
    const arrivalCoordinates =
      acceptDto.arrivalCoordinates ??
      this.pointToCoordinates(tripRequest.arrivalPoint);

    // Create Trip from TripRequest (private by default)
    // The trip is created with the number of seats requested by the passenger (or more if driver specified)
    const trip = await this.tripsService.create(
      driverId,
      {
        departureLocation: tripRequest.departureLocation,
        departureReference:
          acceptDto.departureReference ||
          tripRequest.departureReference ||
          undefined,
        arrivalLocation: tripRequest.arrivalLocation,
        arrivalReference:
          acceptDto.arrivalReference ||
          tripRequest.arrivalReference ||
          undefined,
        departureCoordinates: departureCoordinates ?? undefined,
        arrivalCoordinates: arrivalCoordinates ?? undefined,
        departureDate: departureDate.toISOString(),
        totalSeats: totalSeats, // Use calculated totalSeats (passenger's request or driver's override)
        pricePerSeat, // Exact price confirmed by the passenger, without re-estimation
        isFree: pricePerSeat === 0,
        requiresPassengerKyc,
        vehicleId: vehicle.id,
        description: tripRequest.description || undefined,
      },
      {
        isPrivate: true, // Trajet privé par défaut
        tripRequestId: tripRequest.id,
        requestSnapshot: tripRequest,
      },
    );

    // Create booking for the passenger automatically with the number of seats they requested
    try {
      await this.bookingsService.create(tripRequest.passengerId, {
        tripId: trip.id,
        numberOfSeats: tripRequest.numberOfSeats,
        passengerOrigin: tripRequest.departureLocation,
        passengerOriginReference: tripRequest.departureReference || undefined,
        passengerDestination: tripRequest.arrivalLocation,
        passengerDestinationReference: tripRequest.arrivalReference || undefined,
        paymentMode: tripRequest.paymentMode,
      });
    } catch (error) {
      try {
        await this.tripsService.cancelFailedRequestTrip(trip.id, driverId, tripRequest.id);
      } catch {
        this.logger.warn('Unable to cancel an empty request trip after booking failure');
      }
      throw error;
    }

    // Accept the booking automatically
    const bookings = await this.bookingsService.findAllByTrip(
      trip.id,
      driverId,
    );
    const passengerBooking = bookings.find(
      (b) => b.passengerId === tripRequest.passengerId,
    );
    if (passengerBooking) {
      await this.bookingsService.acceptBooking(passengerBooking.id, driverId);
    }

    // Update trip request
    tripRequest.status = TripRequestStatus.DRIVER_SELECTED;
    tripRequest.selectedDriverId = driverId;
    tripRequest.selectedVehicleId = vehicle.id;
    tripRequest.selectedPricePerSeat = pricePerSeat;
    tripRequest.selectedDriverRequiresPassengerKyc = requiresPassengerKyc;
    const selectedAt = new Date();
    tripRequest.selectedAt = selectedAt;
    tripRequest.tripId = trip.id;
    tripRequest.driverPickupOverdueNotifiedAt = null;
    await this.tripRequestRepository.manager.transaction(async manager => {
      const requests = manager.getRepository(TripRequest);
      const current = await requests.findOne({ where: { id: tripRequestId }, lock: { mode: 'pessimistic_write' } });
      if (!current || [TripRequestStatus.CANCELLED, TripRequestStatus.EXPIRED].includes(current.status) ||
          (current.selectedDriverId && current.selectedDriverId !== driverId) ||
          (current.tripId && current.tripId !== trip.id)) {
        throw new ConflictException('Cette commande a changé. Actualisez ses détails.');
      }
      await requests.save(tripRequest);
      await manager.getRepository(DriverOffer).update(
        { tripRequestId, status: DriverOfferStatus.PENDING }, { status: DriverOfferStatus.REJECTED },
      );
      await enqueueTransactionalNotification(manager, {
        eventKey: `request-accepted:${tripRequest.id}:${trip.id}`, userId: tripRequest.passengerId,
        title: 'Commande acceptée', body: 'Un conducteur a accepté votre commande. Ouvrez-la pour voir les détails.',
        data: { type: 'trip_request_accepted', tripRequestId, tripId: trip.id, driverId,
          requiresPassengerKyc, selectedAt: selectedAt.toISOString() },
      });
    });

    this.logger.log(
      `Trip request ${tripRequestId} accepted by driver ${driverId}, trip ${trip.id} created`,
    );

    return {
      trip,
      tripRequest: await this.findOne(tripRequestId, driverId),
    };
  }

  async cancel(passengerId: string, tripRequestId: string): Promise<void> {
    this.logger.log(
      `Cancelling trip request ${tripRequestId} by passenger ${passengerId}`,
    );

    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId, passengerId },
    });

    if (!tripRequest) {
      throw new NotFoundException(
        "Commande de trajet non trouvée ou vous n'êtes pas le propriétaire",
      );
    }

    if (!tripRequest.selectedDriverId && !tripRequest.tripId &&
        tripRequest.status !== TripRequestStatus.DRIVER_SELECTED) {
      await this.tripRequestRepository.manager.transaction(async (manager) => {
        const locked = await manager.getRepository(TripRequest).findOne({
          where: { id: tripRequestId, passengerId }, lock: { mode: 'pessimistic_write' },
        });
        if (!locked || locked.selectedDriverId || locked.tripId) {
          throw new BadRequestException('Un conducteur vient de répondre. Actualisez la commande avant de l’annuler.');
        }
        locked.status = TripRequestStatus.CANCELLED;
        await manager.getRepository(TripRequest).save(locked);
        await manager.getRepository(DriverOffer).update(
          { tripRequestId, status: DriverOfferStatus.PENDING }, { status: DriverOfferStatus.CANCELLED });
        await manager.query(`UPDATE trip_request_dispatch_offers SET status = 'cancelled' WHERE "requestId" = $1 AND status = 'pending'`, [tripRequestId]);
      });
      return;
    }
    if (
      tripRequest.status === TripRequestStatus.DRIVER_SELECTED &&
      tripRequest.tripId
    ) {
      const trip = await this.tripsService.findOne(tripRequest.tripId);
      const isSharedAddition = await this.driverOfferRepository.exists({
        where: { tripRequestId, existingTripId: trip.id, status: DriverOfferStatus.ACCEPTED },
      });

      if (!isSharedAddition && (trip.status !== TripStatus.PENDING || trip.startedAt)) {
        throw new BadRequestException(
          'Vous ne pouvez plus annuler cette commande car le trajet a déjà démarré',
        );
      }

      const passengerBooking = trip.bookings?.find(
        (booking) =>
          booking.passengerId === passengerId &&
          [BookingStatus.PENDING, BookingStatus.ACCEPTED].includes(
            booking.status,
          ),
      );

      if (passengerBooking) {
        if (isSharedAddition && (passengerBooking.pickedUp || passengerBooking.pickedUpAt ||
            passengerBooking.pickedUpConfirmedByPassenger))
          throw new BadRequestException('Après embarquement, utilisez la demande d’arrêt du trajet.');
        await this.bookingsService.cancel(passengerBooking.id, passengerId);
      }
    }

    tripRequest.status = TripRequestStatus.CANCELLED;
    await this.tripRequestRepository.save(tripRequest);

    // Cancel all offers that were still actionable, including the accepted one.
    await this.driverOfferRepository.update(
      {
        tripRequestId,
        status: In([DriverOfferStatus.PENDING, DriverOfferStatus.ACCEPTED]),
      },
      { status: DriverOfferStatus.CANCELLED },
    );

    this.logger.log(`Trip request ${tripRequestId} cancelled`);
  }

  async releaseOverdueSelectedDriver(
    passengerId: string,
    tripRequestId: string,
  ): Promise<SanitizedTripRequest> {
    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId, passengerId },
    });

    if (!tripRequest) {
      throw new NotFoundException(
        "Commande de trajet non trouvée ou vous n'êtes pas le propriétaire",
      );
    }

    if (
      tripRequest.status !== TripRequestStatus.DRIVER_SELECTED ||
      !tripRequest.selectedDriverId
    ) {
      throw new BadRequestException(
        "Cette commande n'a plus de conducteur sélectionné",
      );
    }

    const latestPickupAt = new Date(tripRequest.departureDateMax).getTime();
    if (!Number.isFinite(latestPickupAt) || latestPickupAt > Date.now()) {
      throw new BadRequestException(
        "La plage de prise en charge n'est pas encore dépassée",
      );
    }

    if (tripRequest.tripId) {
      let linkedTrip: Awaited<ReturnType<TripsService['findOne']>> | null =
        null;

      try {
        linkedTrip = await this.tripsService.findOne(tripRequest.tripId);
      } catch (error) {
        if (!(error instanceof NotFoundException)) {
          throw error;
        }
      }

      const passengerBooking = linkedTrip?.bookings?.find(
        (booking) => booking.passengerId === passengerId,
      );

      if (
        passengerBooking &&
        (passengerBooking.pickedUp ||
          passengerBooking.pickedUpConfirmedByPassenger ||
          passengerBooking.pickedUpAt)
      ) {
        throw new BadRequestException(
          'Le conducteur ne peut plus être libéré après la prise en charge du passager',
        );
      }

      if (
        passengerBooking &&
        [BookingStatus.PENDING, BookingStatus.ACCEPTED].includes(
          passengerBooking.status,
        )
      ) {
        await this.bookingsService.cancel(passengerBooking.id, passengerId);
      }
    }

    const reopened =
      await this.tripRequestRecoveryService.reopenAfterPassengerReleasesOverdueDriver(
        tripRequestId,
        passengerId,
      );

    if (!reopened) {
      throw new BadRequestException(
        'La commande a changé entre-temps. Actualisez-la avant de réessayer.',
      );
    }

    return this.findOne(tripRequestId, passengerId);
  }

  private buildPointFromCoordinates(
    coordinates?: [number, number] | null,
  ): Point | null {
    if (!coordinates) {
      return null;
    }
    const [longitude, latitude] = coordinates;
    return {
      type: 'Point',
      coordinates: [Number(longitude), Number(latitude)],
    };
  }

  private async calculateRecommendedPricePerSeat(
    departurePoint: Point | null,
    arrivalPoint: Point | null,
    vehicleType: VehicleType | undefined | null,
    context: string,
  ): Promise<number | null> {
    const distanceMeters = await this.calculateRouteDistanceMeters(
      departurePoint,
      arrivalPoint,
      context,
    );
    const weatherImpact = await this.weatherAwarenessService.getRouteImpact(
      this.pointToCoordinates(departurePoint),
      this.pointToCoordinates(arrivalPoint),
    );

    return this.buildRecommendedPricePerSeat(
      distanceMeters,
      vehicleType,
      weatherImpact.priceMultiplier,
    );
  }

  private buildRecommendedPricePerSeat(
    distanceMeters: number | null,
    vehicleType: VehicleType | undefined | null,
    priceMultiplier = 1,
  ): number | null {
    if (
      typeof distanceMeters !== 'number' ||
      !Number.isFinite(distanceMeters) ||
      distanceMeters <= 0
    ) {
      return null;
    }

    const distanceKm = distanceMeters / 1000;
    const pricePerKmPerPassenger =
      this.getRecommendedPricePerKmPerPassenger(vehicleType);

    const safeMultiplier =
      Number.isFinite(priceMultiplier) && priceMultiplier >= 1
        ? priceMultiplier
        : 1;

    return Math.round(distanceKm * pricePerKmPerPassenger * safeMultiplier);
  }

  private getRecommendedPricePerKmPerPassenger(
    vehicleType: VehicleType | undefined | null,
  ): number {
    return (
      this.RECOMMENDED_PRICE_PER_KM_PER_PASSENGER_BY_VEHICLE_TYPE[
        vehicleType ?? VehicleType.CAR
      ] ??
      this.RECOMMENDED_PRICE_PER_KM_PER_PASSENGER_BY_VEHICLE_TYPE[
        VehicleType.CAR
      ]
    );
  }

  private async calculateRouteDistanceMeters(
    departurePoint: Point | null,
    arrivalPoint: Point | null,
    context: string,
  ): Promise<number | null> {
    const departureCoordinates = this.pointToCoordinates(departurePoint);
    const arrivalCoordinates = this.pointToCoordinates(arrivalPoint);

    if (!departureCoordinates || !arrivalCoordinates) {
      return null;
    }

    const [departureLongitude, departureLatitude] = departureCoordinates;
    const [arrivalLongitude, arrivalLatitude] = arrivalCoordinates;

    try {
      const directions = await this.googleMapsService.getDirections({
        origin: { lat: departureLatitude, lng: departureLongitude },
        destination: { lat: arrivalLatitude, lng: arrivalLongitude },
        mode: TravelMode.DRIVING,
        region: 'CD',
      });
      const distanceMeters = directions.routes?.[0]?.legs?.reduce(
        (sum, leg) => sum + (Number(leg.distance) || 0),
        0,
      );

      if (distanceMeters && distanceMeters > 0) {
        return Math.round(distanceMeters);
      }

      this.logger.warn(
        `Google Directions returned no usable distance for ${context}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Unable to calculate route distance for ${context}: ${message}`,
      );
    }

    return this.calculateStraightLineDistanceMeters(
      { latitude: departureLatitude, longitude: departureLongitude },
      { latitude: arrivalLatitude, longitude: arrivalLongitude },
    );
  }

  private calculateStraightLineDistanceMeters(
    departure: { latitude: number; longitude: number },
    arrival: { latitude: number; longitude: number },
  ): number | null {
    if (
      !Number.isFinite(departure.latitude) ||
      !Number.isFinite(departure.longitude) ||
      !Number.isFinite(arrival.latitude) ||
      !Number.isFinite(arrival.longitude)
    ) {
      return null;
    }

    const toRadians = (value: number) => (value * Math.PI) / 180;
    const earthRadiusMeters = 6371000;
    const latitudeDelta = toRadians(arrival.latitude - departure.latitude);
    const longitudeDelta = toRadians(arrival.longitude - departure.longitude);
    const departureLatitude = toRadians(departure.latitude);
    const arrivalLatitude = toRadians(arrival.latitude);
    const haversine =
      Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(departureLatitude) *
        Math.cos(arrivalLatitude) *
        Math.sin(longitudeDelta / 2) ** 2;
    const centralAngle =
      2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));

    return Math.round(earthRadiusMeters * centralAngle);
  }

  private async resolvePointFromCoordinatesOrAddress(
    coordinates: [number, number] | undefined | null,
    address?: string | null,
    reference?: string | null,
    context = 'address',
  ): Promise<Point | null> {
    const coordinatesPoint = this.buildPointFromCoordinates(coordinates);
    if (coordinatesPoint) {
      return coordinatesPoint;
    }

    return this.geocodeAddressToPoint(address, reference, context);
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
    return this.buildPointFromCoordinates([bestResult.lng, bestResult.lat]);
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

  private pointToCoordinates(point?: Point | null): [number, number] | null {
    if (!point?.coordinates) {
      return null;
    }
    const [longitude, latitude] = point.coordinates;
    return [Number(longitude), Number(latitude)];
  }

  /** Explicit contact lookup only; list/detail payloads keep their privacy rules. */
  async getPassengerContact(requestId: string, driverId: string) {
    const driver = driverId
      ? await this.userRepository.findOne({ where: { id: driverId } })
      : null;
    if (!driver) throw new ForbiddenException('Accès réservé aux conducteurs');
    await assertDriverCanOperate(this.userRepository.manager, driver);

    const request = await this.tripRequestRepository.findOne({
      where: { id: requestId },
      relations: ['passenger', 'driverOffers'],
      select: {
        id: true, passengerId: true, status: true, selectedDriverId: true,
        tripId: true, immediateDispatch: true, departureDateMax: true,
        passenger: { id: true, firstName: true, lastName: true, phone: true },
        driverOffers: { id: true, status: true },
      },
    });
    if (!request?.passenger || request.passengerId === driverId ||
      ![TripRequestStatus.PENDING, TripRequestStatus.OFFERS_RECEIVED].includes(request.status) ||
      this.hasAcceptedDriver(request)) {
      throw new NotFoundException('Cette commande n’est plus disponible pour contacter le passager.');
    }
    let deadline = this.getRequestExpirationAt(request)?.getTime() ?? NaN;
    if (request.immediateDispatch) {
      // Only the currently invited driver can access an immediate request's contact.
      const offerDeadline = await this.driverDispatch?.getContactDeadline(driverId, requestId);
      deadline = Math.min(deadline, offerDeadline?.getTime() ?? NaN);
    }
    const now = Date.now();
    if (!Number.isFinite(deadline) || deadline <= now) {
      throw new NotFoundException('Cette commande n’est plus disponible pour contacter le passager.');
    }
    return {
      requestId: request.id,
      passenger: {
        id: request.passenger.id,
        name: [request.passenger.firstName, request.passenger.lastName].filter(Boolean).join(' ').trim() || 'Passager',
        phone: request.passenger.phone?.trim() || null,
      },
      expiresAt: new Date(deadline).toISOString(),
      serverNow: new Date(now).toISOString(),
    };
  }

  private async assertDriverViewer(userId: string): Promise<void> {
    const user = userId
      ? await this.userRepository.findOne({ where: { id: userId } })
      : null;
    if (user?.role !== UserRole.DRIVER) {
      throw new ForbiddenException('Accès réservé aux conducteurs');
    }
  }

  private getSelectedDriverId(tripRequest: TripRequest): string | null {
    return (
      tripRequest.selectedDriverId ??
      tripRequest.driverOffers?.find(
        (offer) => offer.status === DriverOfferStatus.ACCEPTED,
      )?.driverId ??
      null
    );
  }

  private canShareContact(tripRequest: TripRequest, viewerId?: string): boolean {
    const selectedDriverId = this.getSelectedDriverId(tripRequest);
    return Boolean(
      selectedDriverId &&
        viewerId &&
        (viewerId === tripRequest.passengerId || viewerId === selectedDriverId),
    );
  }

  private async sanitizeUser(
    user?: User,
    includePhone = false,
  ): Promise<SanitizedUser | null> {
    if (!user) {
      return null;
    }

    const profilePicture = user.profilePicture
      ? await this.fileUploadService.getPresignedUrlIfS3Key(user.profilePicture)
      : null;
    const premium = await this.subscriptionsService.getPremiumOverview(user.id);

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      ...(includePhone ? { phone: user.phone } : {}),
      gender: user.gender ?? null,
      profilePicture: profilePicture || user.profilePicture,
      isPremium: premium.isPremium,
      premiumBadge: premium.premiumBadgeEnabled,
    };
  }

  private async sanitizeVehicle(
    vehicle?: Vehicle,
  ): Promise<SanitizedVehicle | null> {
    if (!vehicle) {
      return null;
    }

    let photoUrl = vehicle.photoUrl;
    if (photoUrl) {
      photoUrl =
        (await this.fileUploadService.getPresignedUrlIfS3Key(photoUrl)) ||
        photoUrl;
    }

    return {
      id: vehicle.id,
      type: vehicle.type,
      brand: vehicle.brand,
      model: vehicle.model,
      color: vehicle.color,
      licensePlate: vehicle.licensePlate,
      photoUrl,
    };
  }

  private assertVehicleSeatCapacity(
    vehicle: Vehicle,
    totalSeats: number,
  ): void {
    const maxSeats = getVehicleMaxSeats(vehicle.type);
    if (maxSeats !== null && totalSeats > maxSeats) {
      throw new BadRequestException(
        `Ce type de moto accepte au maximum ${maxSeats} places`,
      );
    }
  }

  private assertRequestedVehicleSeatCapacity(
    vehicleType: VehicleType,
    numberOfSeats: number,
  ): void {
    const maximumSeats = getVehicleMaxSeats(vehicleType);
    if (maximumSeats !== null && numberOfSeats > maximumSeats) {
      throw new BadRequestException(
        `Ce type de véhicule accepte au maximum ${maximumSeats} place(s)`,
      );
    }
  }

  private assertVehicleMatchesTripRequest(
    vehicle: Vehicle,
    tripRequest: TripRequest,
  ): void {
    const requestedType = tripRequest.vehicleType ?? VehicleType.CAR;
    if ((vehicle.type ?? VehicleType.CAR) !== requestedType) {
      throw new BadRequestException({
        error: 'Type de véhicule incompatible',
        code: 'TRIP_REQUEST_VEHICLE_TYPE_MISMATCH',
        message: `Cette commande nécessite le type ${this.VEHICLE_TYPE_DISPLAY_NAMES[requestedType]}. Sélectionnez un véhicule actif correspondant.`,
      });
    }
  }

  private async hasApprovedPassengerKyc(passengerId: string): Promise<boolean> {
    const passenger = await this.userRepository.findOne({
      where: { id: passengerId },
      relations: ['kycDocuments'],
    });

    return this.passengerHasApprovedKyc(passenger);
  }

  private passengerHasApprovedKyc(
    passenger: Pick<User, 'kycDocuments'> | null | undefined,
  ): boolean {
    return Boolean(
      passenger?.kycDocuments?.some(
        (document) => document.status === KycStatus.APPROVED,
      ),
    );
  }

  private ensurePassengerKycForExtraSeats(
    passenger: Pick<User, 'kycDocuments'>,
    numberOfSeats: number,
  ): void {
    if (
      numberOfSeats <= this.MAX_SEATS_WITHOUT_APPROVED_KYC ||
      this.passengerHasApprovedKyc(passenger)
    ) {
      return;
    }

    this.throwPassengerKycRequiredForExtraSeats();
  }

  private async ensurePassengerKycForExtraSeatsById(
    passengerId: string,
    numberOfSeats: number,
  ): Promise<void> {
    if (
      numberOfSeats <= this.MAX_SEATS_WITHOUT_APPROVED_KYC ||
      (await this.hasApprovedPassengerKyc(passengerId))
    ) {
      return;
    }

    this.throwPassengerKycRequiredForExtraSeats();
  }

  private throwPassengerKycRequiredForExtraSeats(): never {
    throw new BadRequestException({
      error: "Vérification d’identité du passager requise",
      code: 'PASSENGER_KYC_REQUIRED',
      message: `Pour réserver plus de ${this.MAX_SEATS_WITHOUT_APPROVED_KYC} places, votre identité doit être vérifiée.`,
      action: 'complete_kyc',
      reason: 'extra_seats',
      maximumSeatsWithoutKyc: this.MAX_SEATS_WITHOUT_APPROVED_KYC,
    });
  }

  private async ensurePassengerKycApprovedForDriverRequirement(
    passengerId: string,
    context: {
      tripRequestId: string;
      offerId?: string;
      driverId: string;
      message: string;
    },
  ): Promise<void> {
    if (await this.hasApprovedPassengerKyc(passengerId)) {
      return;
    }

    throw new BadRequestException({
      error: "Vérification d’identité du passager requise",
      code: 'PASSENGER_KYC_REQUIRED',
      message: context.message,
      action: 'complete_kyc',
      tripRequestId: context.tripRequestId,
      offerId: context.offerId,
      driverId: context.driverId,
    });
  }

  private async sanitizeDriverOffer(
    offer: DriverOffer,
    tripRequest?: TripRequest,
    viewerId?: string,
  ): Promise<SanitizedDriverOffer> {
    if (!offer.driver) {
      throw new Error(`Driver offer ${offer.id} has no driver associated`);
    }

    const accepted = Boolean(
      tripRequest &&
        offer.status === DriverOfferStatus.ACCEPTED &&
        this.getSelectedDriverId(tripRequest) === offer.driverId &&
        this.canShareContact(tripRequest, viewerId),
    );
    const driver = await this.sanitizeUser(offer.driver, accepted);
    if (!driver) {
      throw new Error(`Failed to sanitize driver for offer ${offer.id}`);
    }

    return {
      id: offer.id,
      existingTripId: offer.existingTripId ?? null,
      sharedTripConsentRequired: Boolean(offer.existingTripId),
      driver,
      vehicle: await this.sanitizeVehicle(offer.vehicle || undefined),
      proposedDepartureDate: offer.proposedDepartureDate,
      pricePerSeat: Number(offer.pricePerSeat),
      availableSeats: offer.availableSeats,
      message: offer.message,
      requiresPassengerKyc: Boolean(offer.requiresPassengerKyc),
      departureReference: offer.departureReference,
      departureCoordinates: this.pointToCoordinates(offer.departurePoint),
      arrivalReference: offer.arrivalReference,
      arrivalCoordinates: this.pointToCoordinates(offer.arrivalPoint),
      status: offer.status,
      createdAt: offer.createdAt,
    };
  }

  private async sanitizeDriverOfferWithTripRequest(
    offer: DriverOffer,
    viewerId: string,
  ): Promise<SanitizedDriverOfferWithTripRequest> {
    if (!offer.driver) {
      throw new Error(`Driver offer ${offer.id} has no driver associated`);
    }

    if (!offer.tripRequest) {
      throw new Error(
        `Driver offer ${offer.id} has no trip request associated`,
      );
    }

    if (!offer.tripRequest.passenger) {
      throw new Error(
        `Trip request ${offer.tripRequest.id} has no passenger associated`,
      );
    }

    // my-offers does not load tripRequest.driverOffers; supply this offer for legacy selections.
    const tripRequest = { ...offer.tripRequest, driverOffers: [offer] };
    const accepted =
      offer.status === DriverOfferStatus.ACCEPTED &&
      this.getSelectedDriverId(tripRequest) === offer.driverId &&
      this.canShareContact(tripRequest, viewerId);
    const passenger = await this.sanitizeUser(tripRequest.passenger, accepted);
    if (!passenger) {
      throw new Error(
        `Failed to sanitize passenger for trip request ${offer.tripRequest.id}`,
      );
    }

    return {
      ...(await this.sanitizeDriverOffer(offer, tripRequest, viewerId)),
      tripRequest: {
        id: offer.tripRequest.id,
        departureLocation: offer.tripRequest.departureLocation,
        departureReference: offer.tripRequest.departureReference,
        arrivalLocation: offer.tripRequest.arrivalLocation,
        arrivalReference: offer.tripRequest.arrivalReference,
        departureDateMin: offer.tripRequest.departureDateMin,
        departureDateMax: offer.tripRequest.departureDateMax,
        numberOfSeats: offer.tripRequest.numberOfSeats,
        maxPricePerSeat: offer.tripRequest.maxPricePerSeat != null
          ? Number(offer.tripRequest.maxPricePerSeat)
          : null,
        vehicleType: offer.tripRequest.vehicleType ?? VehicleType.CAR,
        paymentMode: offer.tripRequest.paymentMode,
        status: offer.tripRequest.status,
        passenger,
      },
    };
  }

  private async sanitizeTripRequest(
    tripRequest: TripRequest,
    viewerId?: string,
    previewOnly = false,
  ): Promise<SanitizedTripRequest> {
    if (!tripRequest.passenger) {
      throw new Error(
        `Trip request ${tripRequest.id} has no passenger associated`,
      );
    }

    const isOwner =
      !previewOnly && Boolean(viewerId) && viewerId === tripRequest.passengerId;
    const shareContact =
      !previewOnly && this.canShareContact(tripRequest, viewerId);
    const passenger = await this.sanitizeUser(
      tripRequest.passenger,
      shareContact,
    );
    if (!passenger) {
      throw new Error(
        `Failed to sanitize passenger for trip request ${tripRequest.id}`,
      );
    }

    return {
      id: tripRequest.id,
      immediateDispatch: tripRequest.immediateDispatch ?? false,
      passenger,
      // Authenticated drivers need exact pickup/drop-off points before accepting.
      // Contact disclosure is a separate, acceptance-dependent permission.
      departureLocation: tripRequest.departureLocation,
      departureReference: tripRequest.departureReference,
      arrivalLocation: tripRequest.arrivalLocation,
      arrivalReference: tripRequest.arrivalReference,
      departureCoordinates: this.pointToCoordinates(tripRequest.departurePoint),
      arrivalCoordinates: this.pointToCoordinates(tripRequest.arrivalPoint),
      departureDateMin: tripRequest.departureDateMin,
      departureDateMax: tripRequest.departureDateMax,
      numberOfSeats: tripRequest.numberOfSeats,
      maxPricePerSeat: tripRequest.maxPricePerSeat != null
        ? Number(tripRequest.maxPricePerSeat)
        : null,
      vehicleType: tripRequest.vehicleType ?? VehicleType.CAR,
      paymentMode: tripRequest.paymentMode,
      description: tripRequest.description,
      status: tripRequest.status,
      selectedDriver: await this.sanitizeUser(
        tripRequest.selectedDriver || undefined,
        shareContact,
      ),
      selectedVehicle: await this.sanitizeVehicle(
        tripRequest.selectedVehicle || undefined,
      ),
      selectedPricePerSeat: tripRequest.selectedPricePerSeat != null
        ? Number(tripRequest.selectedPricePerSeat)
        : null,
      selectedDriverRequiresPassengerKyc: Boolean(
        tripRequest.selectedDriverRequiresPassengerKyc,
      ),
      selectedAt: tripRequest.selectedAt,
      tripId: tripRequest.tripId,
      driverPickupOverdueNotifiedAt: tripRequest.driverPickupOverdueNotifiedAt,
      driverOffers: tripRequest.driverOffers
        ? await Promise.all(
            tripRequest.driverOffers
              .filter(
                (offer) => isOwner || (viewerId && offer.driverId === viewerId),
              )
              .map((offer) =>
                this.sanitizeDriverOffer(
                  offer,
                  tripRequest,
                  previewOnly ? undefined : viewerId,
                ),
              ),
          )
        : [],
      createdAt: tripRequest.createdAt,
      updatedAt: tripRequest.updatedAt,
    };
  }

  private isAvailableRequest(tripRequest: TripRequest, now: Date): boolean {
    if (tripRequest.immediateDispatch || this.hasAcceptedDriver(tripRequest) ||
      ![TripRequestStatus.PENDING, TripRequestStatus.OFFERS_RECEIVED].includes(tripRequest.status)) {
      return false;
    }
    const deadline = this.getRequestExpirationAt(tripRequest);
    // An invalid date cannot prove that a public request is still available.
    return deadline !== null && deadline.getTime() > now.getTime();
  }

  private getRequestExpirationAt(tripRequest: TripRequest): Date | null {
    const latestAcceptedDepartureAt = new Date(
      tripRequest.departureDateMax,
    ).getTime();
    if (!Number.isFinite(latestAcceptedDepartureAt)) {
      return null;
    }

    const gracePeriod = this.hasAcceptedDriver(tripRequest)
      ? this.ACCEPTED_REQUEST_EXPIRATION_MS
      : this.UNACCEPTED_REQUEST_EXPIRATION_MS;
    return new Date(latestAcceptedDepartureAt + gracePeriod);
  }

  private hasAcceptedDriver(tripRequest: TripRequest): boolean {
    return (
      tripRequest.status === TripRequestStatus.DRIVER_SELECTED ||
      Boolean(tripRequest.selectedDriverId) ||
      Boolean(tripRequest.tripId) ||
      Boolean(
        tripRequest.driverOffers?.some(
          (offer) => offer.status === DriverOfferStatus.ACCEPTED,
        ),
      )
    );
  }

  private shouldExpireRequest(tripRequest: TripRequest, now: Date): boolean {
    const hasActiveRequestStatus =
      tripRequest.status === TripRequestStatus.PENDING ||
      tripRequest.status === TripRequestStatus.OFFERS_RECEIVED ||
      tripRequest.status === TripRequestStatus.DRIVER_SELECTED;

    if (!hasActiveRequestStatus) {
      return false;
    }

    const expirationAt = this.getRequestExpirationAt(tripRequest);
    return expirationAt !== null && expirationAt.getTime() <= now.getTime();
  }

  private async expireRequests(
    tripRequests: TripRequest[],
    now = new Date(),
  ): Promise<string[]> {
    const expiredRequests = tripRequests.filter((tripRequest) =>
      this.shouldExpireRequest(tripRequest, now),
    );

    if (expiredRequests.length === 0) {
      return [];
    }

    const expiredIds: string[] = [];
    // Bounded DB concurrency even when a legacy history read supplies many rows.
    for (const request of expiredRequests) {
      const changed = await this.tripRequestRepository.manager.transaction(async manager => {
        const result = await manager.getRepository(TripRequest).update(
          {
            id: request.id,
            // Match the snapshot: an acceptance, release or schedule edit that
            // wins this race must not be overwritten by expiration.
            status: request.status,
            selectedDriverId: request.selectedDriverId ?? IsNull(),
            tripId: request.tripId ?? IsNull(),
            departureDateMax: request.departureDateMax,
            ...(request.updatedAt
              ? {
                  // pg parses timestamp microseconds into JS millisecond Dates.
                  // Keep the version check at the actual precision of that snapshot;
                  // plain equality would reject unchanged database timestamps.
                  updatedAt: Raw(
                    (column) =>
                      `date_trunc('milliseconds', ${column}) = :expirationSnapshotUpdatedAt`,
                    { expirationSnapshotUpdatedAt: request.updatedAt },
                  ),
                }
              : {}),
          },
          { status: TripRequestStatus.EXPIRED },
        );

        if (result.affected !== 1) return false;
        await this.notifyPassengerAboutExpiredRequest(manager, request, this.hasAcceptedDriver(request));
        return true;
      });
      // Do not change the caller's snapshot if the outbox INSERT rolls back.
      if (changed) {
        request.status = TripRequestStatus.EXPIRED;
        expiredIds.push(request.id);
      }
    }
    return expiredIds;
  }

  /**
   * Sends an informational push only. The actionable modal is exclusively
   * triggered by the trip_request_driver_overdue notification type.
   */
  private async notifyPassengerAboutExpiredRequest(
    manager: EntityManager,
    tripRequest: TripRequest,
    wasAccepted: boolean,
  ): Promise<void> {
    // Expiring the request never cancels its linked trip, bookings or payments.
    // Do not send a misleading cancellation/no-driver push during a real trip.
    if (wasAccepted) return;
    if (!tripRequest.passengerId) {
      this.logger.warn(
        `Unable to notify the passenger about expired trip request ${tripRequest.id}: passengerId is missing`,
      );
      return;
    }

    await enqueueTransactionalNotification(manager, {
      eventKey: `trip-request-expired:${tripRequest.id}:${new Date(tripRequest.updatedAt ?? tripRequest.departureDateMax).getTime()}`,
      userId: tripRequest.passengerId,
      title: 'Commande de trajet expirée',
      body: `Votre commande de trajet de ${tripRequest.departureLocation} à ${tripRequest.arrivalLocation} a expiré car aucun conducteur ne l'a acceptée.`,
      data: {
        type: 'trip_request_expired',
        presentation: 'push_only',
        tripRequestId: tripRequest.id,
        status: TripRequestStatus.EXPIRED,
        reason: 'no_driver_accepted',
      },
    });
  }

  // ==================== Cron Jobs ====================

  /**
   * Notifie une seule fois le passager lorsque le conducteur sélectionné n'a
   * toujours pas effectué la prise en charge à la fin de la plage souhaitée.
   * Le timestamp persistant permet également au mobile d'afficher la modale
   * après un redémarrage, même si la notification push n'a pas été ouverte.
   */
  @Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true })
  async notifyPassengersAboutOverdueDriverPickup(
    now = new Date(),
  ): Promise<void> {
    const candidates = await this.tripRequestRepository
      .createQueryBuilder('request')
      .where('request.status = :status', {
        status: TripRequestStatus.DRIVER_SELECTED,
      })
      .andWhere('request.departureDateMax <= :now', { now })
      .andWhere('request.departureDateMax > :expirationCutoff', {
        expirationCutoff: new Date(
          now.getTime() - this.ACCEPTED_REQUEST_EXPIRATION_MS,
        ),
      })
      .andWhere('request.driverPickupOverdueNotifiedAt IS NULL')
      .andWhere(
        `(
          request."tripId" IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM "trips" "linkedTrip"
            WHERE "linkedTrip"."id" = request."tripId"::uuid
              AND "linkedTrip"."status" = :completedTripStatus
          )
        )`,
        { completedTripStatus: TripStatus.COMPLETED },
      )
      .andWhere(
        `NOT EXISTS (
          SELECT 1
          FROM "bookings" "passengerBooking"
          WHERE "passengerBooking"."tripId" = request."tripId"::uuid
            AND "passengerBooking"."passengerId" = request."passengerId"
            AND (
              "passengerBooking"."pickedUp" = true
              OR "passengerBooking"."pickedUpConfirmedByPassenger" = true
              OR "passengerBooking"."pickedUpAt" IS NOT NULL
            )
        )`,
      )
      .orderBy('request.departureDateMax', 'ASC')
      .take(100)
      .getMany();

    for (const tripRequest of candidates) {
      if (
        !tripRequest.selectedDriverId ||
        this.shouldExpireRequest(tripRequest, now)
      ) {
        continue;
      }

      const selectedDriverId = tripRequest.selectedDriverId;
      const notifiedAt = new Date();
      await this.tripRequestRepository.manager.transaction(async manager => {
        const claim = await manager.getRepository(TripRequest).update(
          {
            id: tripRequest.id,
            passengerId: tripRequest.passengerId,
            status: TripRequestStatus.DRIVER_SELECTED,
            selectedDriverId,
            driverPickupOverdueNotifiedAt: IsNull(),
            departureDateMax: Between(
              new Date(now.getTime() - this.ACCEPTED_REQUEST_EXPIRATION_MS + 1),
              now,
            ),
          },
          { driverPickupOverdueNotifiedAt: notifiedAt },
        );

        if (claim.affected !== 1) return;

        await enqueueTransactionalNotification(manager, {
          eventKey: `trip-request-overdue:${tripRequest.id}:${new Date(tripRequest.selectedAt ?? tripRequest.departureDateMax).getTime()}:${new Date(tripRequest.departureDateMax).getTime()}`,
          userId: tripRequest.passengerId,
          title: 'Votre prise en charge est en retard',
          body: "L'heure maximale souhaitée est dépassée et vous n'avez pas encore été pris en charge. Vous pouvez attendre ou choisir un autre conducteur. Pensez aussi à ajuster la date et l'heure de votre commande.",
          data: {
            type: 'trip_request_driver_overdue',
            recipientUserId: tripRequest.passengerId,
            tripRequestId: tripRequest.id,
            tripId: tripRequest.tripId ?? '',
            departureDateMax: new Date(
              tripRequest.departureDateMax,
            ).toISOString(),
            driverPickupOverdueNotifiedAt: notifiedAt.toISOString(),
            suggestScheduleUpdate: 'true',
          },
        });
      });
    }
  }

  /**
   * Cron job to mark expired trip requests
   * Runs every thirty seconds. Deadlines start at departureDateMax:
   * three hours without acceptance, two hours once accepted.
   * Only the request is expired; linked trips/bookings/payments stay intact.
   */
  @Cron(CronExpression.EVERY_30_SECONDS, { waitForCompletion: true })
  async markExpiredTripRequests() {
    // Yield to HTTP work, but keep the promise attached to the cron so Nest
    // prevents overlapping runs and handles asynchronous failures.
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.logger.debug('Running cron job to mark expired trip requests');

    const now = new Date();
    const active = In([TripRequestStatus.PENDING, TripRequestStatus.OFFERS_RECEIVED, TripRequestStatus.DRIVER_SELECTED]);
    const acceptedCutoff = LessThanOrEqual(new Date(now.getTime() - this.ACCEPTED_REQUEST_EXPIRATION_MS));
    // Filter both deadlines before LIMIT: unaccepted requests still in their
    // third hour must not starve accepted requests whose two hours have elapsed.
    const expirationCandidates = await this.tripRequestRepository.find({
      where: [
        { status: active, departureDateMax: LessThanOrEqual(new Date(now.getTime() - this.UNACCEPTED_REQUEST_EXPIRATION_MS)) },
        { status: TripRequestStatus.DRIVER_SELECTED, departureDateMax: acceptedCutoff },
        { status: active, departureDateMax: acceptedCutoff, selectedDriverId: Not(IsNull()) },
        { status: active, departureDateMax: acceptedCutoff, tripId: Not(IsNull()) },
        { status: active, departureDateMax: acceptedCutoff, driverOffers: { status: DriverOfferStatus.ACCEPTED } },
      ],
      relations: ['driverOffers'],
      select: { id: true, passengerId: true, status: true, departureDateMax: true, updatedAt: true,
        selectedDriverId: true, tripId: true, departureLocation: true, arrivalLocation: true,
        driverOffers: { id: true, status: true } },
      order: { departureDateMax: 'ASC', id: 'ASC' },
      take: 100,
    });

    const expiredRequestIds = await this.expireRequests(
      expirationCandidates,
      now,
    );

    if (expiredRequestIds.length === 0) {
      this.logger.debug('No expired trip requests found');
      return;
    }

    this.logger.log(
      `Successfully marked ${expiredRequestIds.length} trip requests as expired`,
    );
  }

  /**
   * Cron job to notify passengers about upcoming trip request expiration
   * Runs every 15 minutes to check for trip requests expiring in the next 30 minutes
   */
  @Cron('*/15 * * * *', { waitForCompletion: true })
  async notifyAboutUpcomingTripRequestExpiration() {
    // Await the work so database failures are handled by the scheduler.
    await (async () => {
      this.logger.debug(
        'Running cron job to notify about upcoming trip request expiration',
      );

      const now = new Date();
      const oldestLatestAcceptedDeparture = new Date(
        now.getTime() - this.UNACCEPTED_REQUEST_EXPIRATION_MS,
      );
      const newestLatestAcceptedDeparture = new Date(
        oldestLatestAcceptedDeparture.getTime() + this.EXPIRATION_WARNING_MS,
      );

      const notificationCandidates = await this.tripRequestRepository.find({
        where: {
          status: In([
            TripRequestStatus.PENDING,
            TripRequestStatus.OFFERS_RECEIVED,
          ]),
          departureDateMax: Between(
            oldestLatestAcceptedDeparture,
            newestLatestAcceptedDeparture,
          ),
          expirationNotificationSent: false,
        },
        relations: ['passenger', 'driverOffers'],
      });

      const requestsExpiringSoon = notificationCandidates.filter(
        (tripRequest) => {
          const expirationAt = this.getRequestExpirationAt(tripRequest);
          return (
            !this.hasAcceptedDriver(tripRequest) &&
            expirationAt !== null &&
            expirationAt.getTime() > now.getTime()
          );
        },
      );

      if (requestsExpiringSoon.length === 0) {
        this.logger.debug('No trip requests expiring soon found');
        return;
      }

      this.logger.log(
        `Found ${requestsExpiringSoon.length} trip requests expiring soon`,
      );

      for (const tripRequest of requestsExpiringSoon) {
        try {
          // Notify passenger about upcoming expiration
          await this.notifyPassengerAboutUpcomingExpiration(tripRequest);

          // Mark notification as sent
          await this.tripRequestRepository.update({ id: tripRequest.id,
            departureDateMax: tripRequest.departureDateMax, status: tripRequest.status },
          { expirationNotificationSent: true, updatedAt: () => '"updatedAt"' });
        } catch (error) {
          this.logger.error(
            `Error notifying passenger about trip request expiration ${tripRequest.id}: ${error.message}`,
            error.stack,
          );
        }
      }

      this.logger.log(
        `Successfully notified about ${requestsExpiringSoon.length} trip requests expiring soon`,
      );
    })();
  }

  /**
   * Notify passenger about upcoming trip request expiration
   */
  private async notifyPassengerAboutUpcomingExpiration(
    tripRequest: TripRequest,
  ): Promise<void> {
    const passenger = tripRequest.passenger;

    if (!passenger || !passenger.fcmToken) {
      this.logger.debug(
        `Passenger ${tripRequest.passengerId} has no FCM token, skipping notification`,
      );
      return;
    }

    const minutesUntilExpiration = Math.round(
      ((this.getRequestExpirationAt(tripRequest)?.getTime() ?? Date.now()) -
        Date.now()) /
        (60 * 1000),
    );

    const title = '⏰ Votre commande de trajet expire bientôt';
    const body = `Votre commande de trajet ${tripRequest.departureLocation} → ${tripRequest.arrivalLocation} expire dans ${minutesUntilExpiration} minute(s) si aucun conducteur n'est confirmé.`;

    await this.notificationService.sendNotification(
      passenger.fcmToken,
      title,
      body,
      {
        type: 'trip_request_expiring',
        tripRequestId: tripRequest.id,
        minutesUntilExpiration,
      },
      passenger.id,
    );

    this.logger.log(
      `Notified passenger ${passenger.id} about trip request ${tripRequest.id} expiring in ${minutesUntilExpiration} minutes`,
    );
  }
}
