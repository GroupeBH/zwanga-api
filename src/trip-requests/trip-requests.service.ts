import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Point, LessThan, MoreThan, Between, In } from 'typeorm';
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
} from './dto/trip-request.dto';
import { FileUploadService } from '../common/services/file-upload.service';
import { NotificationService } from '../notifications/notifications.service';
import { TripsService } from '../trips/trips.service';
import { BookingsService } from '../bookings/bookings.service';
import { BookingStatus } from '../bookings/entities/booking.entity';
import { GoogleMapsService } from '../google-maps/google-maps.service';
import { TravelMode } from '../google-maps/dto/google-maps.dto';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { WeatherAwarenessService } from '../weather/weather-awareness.service';
import { WeatherRouteImpact } from '../weather/weather.types';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';

export interface SanitizedUser {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
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
  id: string;
  driver: SanitizedUser;
  vehicle: SanitizedVehicle | null;
  proposedDepartureDate: Date;
  pricePerSeat: number;
  availableSeats: number;
  message: string | null;
  departureReference: string | null;
  departureCoordinates: [number, number] | null;
  arrivalReference: string | null;
  arrivalCoordinates: [number, number] | null;
  status: DriverOfferStatus;
  createdAt: Date;
}

export interface SanitizedDriverOfferWithTripRequest
  extends SanitizedDriverOffer {
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
    paymentMode: TripPaymentMode;
    status: TripRequestStatus;
    passenger: SanitizedUser;
  };
}

export interface SanitizedTripRequest {
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
  paymentMode: TripPaymentMode;
  description: string | null;
  status: TripRequestStatus;
  selectedDriver: SanitizedUser | null;
  selectedVehicle: SanitizedVehicle | null;
  selectedPricePerSeat: number | null;
  selectedAt: Date | null;
  tripId: string | null;
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

@Injectable()
export class TripRequestsService {
  private readonly logger = new Logger(TripRequestsService.name);
  private readonly MAX_SEATS_PER_PASSENGER = 2;
  private readonly RECOMMENDED_PRICE_PER_KM_PER_PASSENGER_BY_VEHICLE_TYPE: Record<
    VehicleType,
    number
  > = {
    [VehicleType.CAR]: 500,
    [VehicleType.MOTORCYCLE_TWO_WHEELS]: 1000,
    [VehicleType.MOTORCYCLE_THREE_WHEELS]: 1000,
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
  ) {}

  async create(
    passengerId: string,
    createTripRequestDto: CreateTripRequestDto,
  ): Promise<SanitizedTripRequest> {
    this.logger.log(`Creating trip request for passenger: ${passengerId}`);

    const passenger = await this.userRepository.findOne({
      where: { id: passengerId },
    });
    if (!passenger) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    if (createTripRequestDto.numberOfSeats > this.MAX_SEATS_PER_PASSENGER) {
      throw new BadRequestException(
        `Pour des raisons de securite du conducteur, vous ne pouvez pas reserver plus de ${this.MAX_SEATS_PER_PASSENGER} places par trajet`,
      );
    }

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
      paymentMode: rest.paymentMode ?? TripPaymentMode.CASH,
      maxPricePerSeat: recommendedPrice,
      passengerId,
      departurePoint,
      arrivalPoint,
      departureDateMin: minDate,
      departureDateMax: maxDate,
    });

    const saved = await this.tripRequestRepository.save(tripRequest);
    this.logger.log(`Trip request created: ${saved.id}`);

    // Notify all active drivers about the new trip request
    await this.notifyDriversAboutTripRequest(saved);

    return this.findOne(saved.id, passengerId);
  }

  async recommendPrice(
    payload: RecommendTripRequestPriceDto,
  ): Promise<TripRequestPriceRecommendation> {
    const numberOfSeats = payload.numberOfSeats ?? 1;
    const vehicleType = payload.vehicleType ?? VehicleType.CAR;

    if (numberOfSeats < 1 || numberOfSeats > this.MAX_SEATS_PER_PASSENGER) {
      throw new BadRequestException(
        `Pour des raisons de securite du conducteur, vous ne pouvez pas reserver plus de ${this.MAX_SEATS_PER_PASSENGER} places par trajet`,
      );
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

  async update(
    passengerId: string,
    tripRequestId: string,
    updateTripRequestDto: UpdateTripRequestDto,
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
        "Demande de trajet non trouvée ou vous n'êtes pas le propriétaire",
      );
    }

    // Check if trip request can be updated (only PENDING or OFFERS_RECEIVED, no driver selected)
    if (tripRequest.status === TripRequestStatus.DRIVER_SELECTED) {
      this.logger.warn(
        `Trip request update failed: Driver already selected for trip request ${tripRequestId}`,
      );
      throw new BadRequestException(
        'Vous ne pouvez pas modifier une demande pour laquelle un driver a été sélectionné',
      );
    }

    if (
      tripRequest.status === TripRequestStatus.CANCELLED ||
      tripRequest.status === TripRequestStatus.EXPIRED
    ) {
      this.logger.warn(
        `Trip request update failed: Trip request ${tripRequestId} is ${tripRequest.status}`,
      );
      throw new BadRequestException(
        'Vous ne pouvez pas modifier une demande annulée ou expirée',
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
        'Vous ne pouvez pas modifier une demande pour laquelle une offre a été acceptée',
      );
    }

    const {
      departureCoordinates,
      arrivalCoordinates,
      departureDateMin,
      departureDateMax,
      vehicleType,
      ...rest
    } = updateTripRequestDto;

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

      tripRequest.departureDateMin = minDate;
      tripRequest.departureDateMax = maxDate;
    }

    // Update other fields
    if (updateTripRequestDto.numberOfSeats !== undefined) {
      if (updateTripRequestDto.numberOfSeats > this.MAX_SEATS_PER_PASSENGER) {
        throw new BadRequestException(
          `Pour des raisons de securite du conducteur, vous ne pouvez pas reserver plus de ${this.MAX_SEATS_PER_PASSENGER} places par trajet`,
        );
      }
      tripRequest.numberOfSeats = updateTripRequestDto.numberOfSeats;
    }

    if (updateTripRequestDto.maxPricePerSeat !== undefined) {
      tripRequest.maxPricePerSeat = updateTripRequestDto.maxPricePerSeat;
    } else if (
      departureCoordinates ||
      arrivalCoordinates ||
      shouldRefreshDeparturePoint ||
      shouldRefreshArrivalPoint ||
      vehicleType !== undefined
    ) {
      const recommendedPrice = await this.calculateRecommendedPricePerSeat(
        tripRequest.departurePoint,
        tripRequest.arrivalPoint,
        vehicleType,
        `trip request ${tripRequest.id} update`,
      );
      if (recommendedPrice !== null) {
        tripRequest.maxPricePerSeat = recommendedPrice;
      }
    }

    if (updateTripRequestDto.paymentMode !== undefined) {
      tripRequest.paymentMode = updateTripRequestDto.paymentMode;
    }

    if (updateTripRequestDto.description !== undefined) {
      tripRequest.description = updateTripRequestDto.description;
    }

    // Reset expiration notification flag if dates changed
    if (departureDateMin || departureDateMax) {
      tripRequest.expirationNotificationSent = false;
    }

    const updated = await this.tripRequestRepository.save(tripRequest);
    this.logger.log(`Trip request updated: ${updated.id}`);

    return this.findOne(updated.id, passengerId);
  }

  private async notifyDriversAboutTripRequest(
    tripRequest: TripRequest,
  ): Promise<void> {
    try {
      // Get all active drivers with FCM tokens, excluding the passenger who created the request
      const drivers = await this.userRepository.find({
        where: {
          isDriver: true,
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

      const title = 'Nouvelle demande de trajet disponible';
      const body = `Un passager cherche un trajet de ${tripRequest.departureLocation} à ${tripRequest.arrivalLocation}`;

      const data = {
        type: 'trip_request',
        tripRequestId: tripRequest.id,
        departureLocation: tripRequest.departureLocation,
        arrivalLocation: tripRequest.arrivalLocation,
        numberOfSeats: tripRequest.numberOfSeats.toString(),
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

  async findAll(): Promise<SanitizedTripRequest[]> {
    this.logger.debug('Fetching all trip requests');

    const now = new Date();
    // Get all trip requests that are not cancelled, expired, or have an accepted offer
    // Include PENDING and OFFERS_RECEIVED statuses (no offer accepted yet)
    // Exclude DRIVER_SELECTED (which means an offer was accepted)
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
        departureDateMax: MoreThan(now), // Exclure les demandes expirées
      },
      order: { createdAt: 'DESC' },
    });

    // Filter out trip requests that have an accepted offer (even if status is not DRIVER_SELECTED yet)
    const visibleTripRequests = tripRequests.filter((tr) => {
      const hasAcceptedOffer = tr.driverOffers?.some(
        (offer) => offer.status === DriverOfferStatus.ACCEPTED,
      );
      return !hasAcceptedOffer;
    });

    return Promise.all(
      visibleTripRequests.map((tr) => this.sanitizeTripRequest(tr)),
    );
  }

  async findOne(id: string, userId?: string): Promise<SanitizedTripRequest> {
    this.logger.debug(`Fetching trip request: ${id}`);

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
      throw new NotFoundException('Demande de trajet non trouvée');
    }

    const isPassenger = userId && tripRequest.passengerId === userId;
    const isSelectedDriver =
      userId &&
      tripRequest.selectedDriverId &&
      tripRequest.selectedDriverId === userId;

    const hasAcceptedOffer = tripRequest.driverOffers?.some(
      (offer) => offer.status === DriverOfferStatus.ACCEPTED,
    );

    const userAcceptedOffer = userId
      ? tripRequest.driverOffers?.find(
          (offer) =>
            offer.driverId === userId &&
            offer.status === DriverOfferStatus.ACCEPTED,
        )
      : undefined;

    // Si aucune offre n'est acceptée, garder le comportement existant (visibilité large)
    if (
      !hasAcceptedOffer &&
      tripRequest.status !== TripRequestStatus.DRIVER_SELECTED
    ) {
      if (userId && !isPassenger) {
        const hasOffer = tripRequest.driverOffers?.some(
          (offer) => offer.driverId === userId,
        );
        if (!hasOffer) {
          // Ne montrer au driver que ses propres offres
          tripRequest.driverOffers =
            tripRequest.driverOffers?.filter(
              (offer) => offer.driverId === userId,
            ) || [];
        }
      }

      return this.sanitizeTripRequest(tripRequest);
    }

    // À partir du moment où une offre est acceptée / le driver sélectionné :
    // - Le passager doit toujours avoir accès
    // - Le driver sélectionné (ou celui avec l'offre acceptée) doit avoir accès
    // - Les autres utilisateurs ne doivent plus voir la trip-request

    // Aucun utilisateur (public) ne voit les demandes avec offre acceptée
    if (!userId) {
      this.logger.debug(
        `Trip request ${id} has an accepted offer and no user authenticated, hiding it`,
      );
      throw new NotFoundException('Demande de trajet non trouvée');
    }

    // Si ce n'est ni le passager, ni le driver sélectionné, ni le driver de l'offre acceptée -> masquer
    if (!isPassenger && !isSelectedDriver && !userAcceptedOffer) {
      this.logger.debug(
        `Trip request ${id} has an accepted offer and user ${userId} is not passenger/selected driver, hiding it`,
      );
      throw new NotFoundException('Demande de trajet non trouvée');
    }

    // Si c'est un driver non passager, ne lui montrer que sa propre offre (l'acceptée)
    if (!isPassenger && userAcceptedOffer) {
      tripRequest.driverOffers = [userAcceptedOffer];
    }

    return this.sanitizeTripRequest(tripRequest);
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
      throw new NotFoundException('Demande de trajet non trouvée');
    }

    // Only passenger can see all offers
    if (userId && tripRequest.passengerId !== userId) {
      throw new ForbiddenException(
        'Seul le passager peut voir toutes les offres',
      );
    }

    if (!tripRequest.driverOffers || tripRequest.driverOffers.length === 0) {
      return [];
    }

    return Promise.all(
      tripRequest.driverOffers.map((offer) => this.sanitizeDriverOffer(offer)),
    );
  }

  async findByPassenger(passengerId: string): Promise<SanitizedTripRequest[]> {
    this.logger.debug(`Fetching trip requests for passenger: ${passengerId}`);

    const now = new Date();
    const tripRequests = await this.tripRequestRepository.find({
      where: {
        passenger: { id: passengerId },
        departureDateMax: MoreThan(now), // Exclure les demandes expirées
      },
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

    return Promise.all(tripRequests.map((tr) => this.sanitizeTripRequest(tr)));
  }

  async findByDriver(
    driverId: string,
  ): Promise<SanitizedDriverOfferWithTripRequest[]> {
    this.logger.debug(`Fetching driver offers for driver: ${driverId}`);

    const offers = await this.driverOfferRepository.find({
      where: { driverId },
      relations: ['driver', 'vehicle', 'tripRequest', 'tripRequest.passenger'],
      order: { createdAt: 'DESC' },
    });

    return Promise.all(
      offers.map((offer) => this.sanitizeDriverOfferWithTripRequest(offer)),
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

    // Vérifier que l'utilisateur est bien un conducteur
    // if (!driver.isDriver || driver.role !== UserRole.DRIVER) {
    //   throw new ForbiddenException('Seuls les conducteurs peuvent faire des offres sur les demandes de trajets. Vous devez être un conducteur pour effectuer cette action.');
    // }

    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId },
      relations: ['passenger', 'driverOffers'],
    });

    if (!tripRequest) {
      throw new NotFoundException('Demande de trajet non trouvée');
    }

    // Check if trip request is expired
    const now = new Date();
    if (tripRequest.departureDateMax < now) {
      throw new BadRequestException('Cette demande de trajet a expiré');
    }

    // Check if trip request status allows new offers
    if (tripRequest.status === TripRequestStatus.DRIVER_SELECTED) {
      throw new BadRequestException(
        "Cette demande de trajet n'accepte plus d'offres car un driver a déjà été sélectionné",
      );
    }

    if (
      tripRequest.status !== TripRequestStatus.PENDING &&
      tripRequest.status !== TripRequestStatus.OFFERS_RECEIVED
    ) {
      throw new BadRequestException(
        "Cette demande de trajet n'accepte plus d'offres",
      );
    }

    // Check if any offer has been accepted (double check even if status is not DRIVER_SELECTED yet)
    const hasAcceptedOffer = tripRequest.driverOffers?.some(
      (offer) => offer.status === DriverOfferStatus.ACCEPTED,
    );

    if (hasAcceptedOffer) {
      throw new BadRequestException(
        "Cette demande de trajet n'accepte plus d'offres car une offre a déjà été acceptée",
      );
    }

    if (tripRequest.passengerId === driverId) {
      throw new BadRequestException(
        'Vous ne pouvez pas faire une offre sur votre propre demande',
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
        'Vous avez déjà fait une offre pour cette demande',
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

    // Validate vehicle if provided
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
    }

    const offer = this.driverOfferRepository.create({
      ...rest,
      tripRequestId,
      driverId,
      vehicleId: vehicleId || null,
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

    const saved = await this.driverOfferRepository.save(offer);

    // Update trip request status (only update status field to avoid relation sync issues)
    if (tripRequest.status === TripRequestStatus.PENDING) {
      await this.tripRequestRepository.update(
        { id: tripRequestId },
        { status: TripRequestStatus.OFFERS_RECEIVED },
      );
    }

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

    return this.sanitizeDriverOffer(offerWithRelations!);
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
      const body = `${driverName} a fait une offre pour votre demande de trajet de ${tripRequest.departureLocation} à ${tripRequest.arrivalLocation}`;

      const data = {
        type: 'driver_offer',
        tripRequestId: tripRequest.id,
        offerId: offer.id,
        driverId: offer.driverId,
        pricePerSeat: offer.pricePerSeat.toString(),
        proposedDepartureDate: offer.proposedDepartureDate.toISOString(),
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
        "Demande de trajet non trouvée ou vous n'êtes pas le propriétaire",
      );
    }

    if (tripRequest.status === TripRequestStatus.DRIVER_SELECTED) {
      throw new BadRequestException(
        'Un driver a déjà été sélectionné pour cette demande',
      );
    }

    if (
      tripRequest.status === TripRequestStatus.CANCELLED ||
      tripRequest.status === TripRequestStatus.EXPIRED
    ) {
      throw new BadRequestException("Cette demande n'accepte plus d'offres");
    }

    const offer = tripRequest.driverOffers?.find(
      (o) => o.id === acceptDto.offerId,
    );
    if (!offer) {
      throw new NotFoundException('Offre du conducteur non trouvée');
    }

    if (offer.status !== DriverOfferStatus.PENDING) {
      throw new BadRequestException("Cette offre n'est plus disponible");
    }

    // Accept the offer
    offer.status = DriverOfferStatus.ACCEPTED;
    offer.acceptedAt = new Date();
    await this.driverOfferRepository.save(offer);

    // Reject all other pending offers
    const otherOffers =
      tripRequest.driverOffers?.filter(
        (o) =>
          o.id !== acceptDto.offerId && o.status === DriverOfferStatus.PENDING,
      ) || [];

    for (const otherOffer of otherOffers) {
      otherOffer.status = DriverOfferStatus.REJECTED;
      otherOffer.rejectedAt = new Date();
      await this.driverOfferRepository.save(otherOffer);
    }

    // Update trip request
    tripRequest.status = TripRequestStatus.DRIVER_SELECTED;
    tripRequest.selectedDriverId = offer.driverId;
    tripRequest.selectedVehicleId = offer.vehicleId;
    tripRequest.selectedPricePerSeat = offer.pricePerSeat;
    tripRequest.selectedAt = new Date();

    await this.tripRequestRepository.save(tripRequest);

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
      throw new NotFoundException('Demande de trajet non trouvée');
    }

    if (tripRequest.status !== TripRequestStatus.DRIVER_SELECTED) {
      throw new BadRequestException(
        'Un driver doit être sélectionné avant de lancer le trajet',
      );
    }

    if (tripRequest.selectedDriverId !== driverId) {
      throw new ForbiddenException(
        "Vous n'êtes pas le driver sélectionné pour cette demande",
      );
    }

    if (tripRequest.tripId) {
      throw new BadRequestException(
        'Un trajet a déjà été créé à partir de cette demande !',
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
        pricePerSeat: tripRequest.selectedPricePerSeat || 0,
        isFree: (tripRequest.selectedPricePerSeat || 0) === 0,
        vehicleId: tripRequest.selectedVehicleId || undefined,
        description: tripRequest.description || undefined,
      },
      {
        isPrivate: true, // Trajet privé par défaut
        tripRequestId: tripRequest.id,
      },
    );

    // Create booking for the passenger automatically (ACCEPTED status)
    await this.bookingsService.create(tripRequest.passengerId, {
      tripId: trip.id,
      numberOfSeats: tripRequest.numberOfSeats,
      passengerOrigin: tripRequest.departureLocation,
      passengerOriginReference: tripRequest.departureReference || undefined,
      passengerDestination: tripRequest.arrivalLocation,
      passengerDestinationReference: tripRequest.arrivalReference || undefined,
      paymentMode: tripRequest.paymentMode,
    });

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
      tripRequest: await this.findOne(tripRequestId, tripRequest.passengerId),
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
      `Driver ${driverId} accepte la demande de trajet ${tripRequestId}`,
    );

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
      throw new NotFoundException('Demande de trajet non trouvée');
    }

    // Check if trip request is expired
    const now = new Date();
    if (tripRequest.departureDateMax < now) {
      throw new BadRequestException('Cette demande de trajet a expiré');
    }

    // Check if trip request can be accepted
    if (tripRequest.status === TripRequestStatus.DRIVER_SELECTED) {
      throw new BadRequestException(
        'Cette demande de trajet a déjà été acceptée par un autre driver',
      );
    }

    if (
      tripRequest.status === TripRequestStatus.CANCELLED ||
      tripRequest.status === TripRequestStatus.EXPIRED
    ) {
      throw new BadRequestException(
        "Cette demande de trajet n'est plus disponible",
      );
    }

    // Check if driver is not the passenger
    if (tripRequest.passengerId === driverId) {
      throw new BadRequestException(
        'Vous ne pouvez pas accepter votre propre demande',
      );
    }

    // Check if trip request already has a trip created
    if (tripRequest.tripId) {
      throw new BadRequestException(
        'Un trajet a déjà été créé à partir de cette demande',
      );
    }

    // Use the maximum price accepted by the passenger, or 0 (free trip) if not specified
    // The driver accepts the request as-is, without proposing a price
    const pricePerSeat = tripRequest.maxPricePerSeat ?? 0;

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
        where: { ownerId: driverId, isActive: true },
      });

      if (!vehicle) {
        throw new BadRequestException(
          'Vous devez avoir au moins un véhicule actif pour accepter une demande',
        );
      }
    }

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
        pricePerSeat: pricePerSeat, // Driver's proposed price (or 0 if not specified)
        isFree: pricePerSeat === 0,
        vehicleId: vehicle.id,
        description: tripRequest.description || undefined,
      },
      {
        isPrivate: true, // Trajet privé par défaut
        tripRequestId: tripRequest.id,
      },
    );

    // Create booking for the passenger automatically with the number of seats they requested
    await this.bookingsService.create(tripRequest.passengerId, {
      tripId: trip.id,
      numberOfSeats: tripRequest.numberOfSeats, // Use the number of seats requested by the passenger
      passengerOrigin: tripRequest.departureLocation,
      passengerOriginReference: tripRequest.departureReference || undefined,
      passengerDestination: tripRequest.arrivalLocation,
      passengerDestinationReference: tripRequest.arrivalReference || undefined,
      paymentMode: tripRequest.paymentMode,
    });

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
    tripRequest.selectedAt = new Date();
    tripRequest.tripId = trip.id;
    await this.tripRequestRepository.save(tripRequest);

    // Reject all pending offers for this trip request
    await this.driverOfferRepository.update(
      { tripRequestId, status: DriverOfferStatus.PENDING },
      { status: DriverOfferStatus.REJECTED },
    );

    // Notify passenger
    try {
      const passenger = await this.userRepository.findOne({
        where: { id: tripRequest.passengerId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      // Reload driver with firstName and lastName for notification
      const driverWithName = await this.userRepository.findOne({
        where: { id: driverId },
        select: ['id', 'firstName', 'lastName'],
      });

      if (passenger?.fcmToken && driverWithName) {
        await this.notificationService.sendNotification(
          passenger.fcmToken,
          'Demande acceptée',
          `${driverWithName.firstName} ${driverWithName.lastName} a accepté votre demande de trajet`,
          {
            type: 'trip_request_accepted',
            tripRequestId: tripRequest.id,
            tripId: trip.id,
            driverId: driverId,
          },
          tripRequest.passengerId,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to notify passenger about trip request acceptance: ${error.message}`,
      );
    }

    this.logger.log(
      `Trip request ${tripRequestId} accepted by driver ${driverId}, trip ${trip.id} created`,
    );

    return {
      trip,
      tripRequest: await this.findOne(tripRequestId, tripRequest.passengerId),
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
        "Demande de trajet non trouvée ou vous n'êtes pas le propriétaire",
      );
    }

    if (tripRequest.status === TripRequestStatus.DRIVER_SELECTED) {
      throw new BadRequestException(
        'Vous ne pouvez pas annuler une demande pour laquelle un driver a été sélectionné',
      );
    }

    tripRequest.status = TripRequestStatus.CANCELLED;
    await this.tripRequestRepository.save(tripRequest);

    // Cancel all pending offers
    await this.driverOfferRepository.update(
      { tripRequestId, status: DriverOfferStatus.PENDING },
      { status: DriverOfferStatus.CANCELLED },
    );

    this.logger.log(`Trip request ${tripRequestId} cancelled`);
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

  private async sanitizeUser(user?: User): Promise<SanitizedUser | null> {
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
      phone: user.phone,
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

  private async sanitizeDriverOffer(
    offer: DriverOffer,
  ): Promise<SanitizedDriverOffer> {
    if (!offer.driver) {
      throw new Error(`Driver offer ${offer.id} has no driver associated`);
    }

    const driver = await this.sanitizeUser(offer.driver);
    if (!driver) {
      throw new Error(`Failed to sanitize driver for offer ${offer.id}`);
    }

    return {
      id: offer.id,
      driver,
      vehicle: await this.sanitizeVehicle(offer.vehicle || undefined),
      proposedDepartureDate: offer.proposedDepartureDate,
      pricePerSeat: Number(offer.pricePerSeat),
      availableSeats: offer.availableSeats,
      message: offer.message,
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

    const driver = await this.sanitizeUser(offer.driver);
    if (!driver) {
      throw new Error(`Failed to sanitize driver for offer ${offer.id}`);
    }

    const passenger = await this.sanitizeUser(offer.tripRequest.passenger);
    if (!passenger) {
      throw new Error(
        `Failed to sanitize passenger for trip request ${offer.tripRequest.id}`,
      );
    }

    return {
      id: offer.id,
      driver,
      vehicle: await this.sanitizeVehicle(offer.vehicle || undefined),
      proposedDepartureDate: offer.proposedDepartureDate,
      pricePerSeat: Number(offer.pricePerSeat),
      availableSeats: offer.availableSeats,
      message: offer.message,
      departureReference: offer.departureReference,
      departureCoordinates: this.pointToCoordinates(offer.departurePoint),
      arrivalReference: offer.arrivalReference,
      arrivalCoordinates: this.pointToCoordinates(offer.arrivalPoint),
      status: offer.status,
      createdAt: offer.createdAt,
      tripRequest: {
        id: offer.tripRequest.id,
        departureLocation: offer.tripRequest.departureLocation,
        departureReference: offer.tripRequest.departureReference,
        arrivalLocation: offer.tripRequest.arrivalLocation,
        arrivalReference: offer.tripRequest.arrivalReference,
        departureDateMin: offer.tripRequest.departureDateMin,
        departureDateMax: offer.tripRequest.departureDateMax,
        numberOfSeats: offer.tripRequest.numberOfSeats,
        maxPricePerSeat: offer.tripRequest.maxPricePerSeat
          ? Number(offer.tripRequest.maxPricePerSeat)
          : null,
        paymentMode: offer.tripRequest.paymentMode,
        status: offer.tripRequest.status,
        passenger,
      },
    };
  }

  private async sanitizeTripRequest(
    tripRequest: TripRequest,
  ): Promise<SanitizedTripRequest> {
    if (!tripRequest.passenger) {
      throw new Error(
        `Trip request ${tripRequest.id} has no passenger associated`,
      );
    }

    const passenger = await this.sanitizeUser(tripRequest.passenger);
    if (!passenger) {
      throw new Error(
        `Failed to sanitize passenger for trip request ${tripRequest.id}`,
      );
    }

    return {
      id: tripRequest.id,
      passenger,
      departureLocation: tripRequest.departureLocation,
      departureReference: tripRequest.departureReference,
      arrivalLocation: tripRequest.arrivalLocation,
      arrivalReference: tripRequest.arrivalReference,
      departureCoordinates: this.pointToCoordinates(tripRequest.departurePoint),
      arrivalCoordinates: this.pointToCoordinates(tripRequest.arrivalPoint),
      departureDateMin: tripRequest.departureDateMin,
      departureDateMax: tripRequest.departureDateMax,
      numberOfSeats: tripRequest.numberOfSeats,
      maxPricePerSeat: tripRequest.maxPricePerSeat
        ? Number(tripRequest.maxPricePerSeat)
        : null,
      paymentMode: tripRequest.paymentMode,
      description: tripRequest.description,
      status: tripRequest.status,
      selectedDriver: await this.sanitizeUser(
        tripRequest.selectedDriver || undefined,
      ),
      selectedVehicle: await this.sanitizeVehicle(
        tripRequest.selectedVehicle || undefined,
      ),
      selectedPricePerSeat: tripRequest.selectedPricePerSeat
        ? Number(tripRequest.selectedPricePerSeat)
        : null,
      selectedAt: tripRequest.selectedAt,
      tripId: tripRequest.tripId,
      driverOffers: tripRequest.driverOffers
        ? await Promise.all(
            tripRequest.driverOffers.map((offer) =>
              this.sanitizeDriverOffer(offer),
            ),
          )
        : [],
      createdAt: tripRequest.createdAt,
      updatedAt: tripRequest.updatedAt,
    };
  }

  // ==================== Cron Jobs ====================

  /**
   * Cron job to mark expired trip requests
   * Runs every hour to check for trip requests with departureDateMax in the past
   */
  @Cron(CronExpression.EVERY_HOUR)
  async markExpiredTripRequests() {
    // Use setImmediate to ensure HTTP requests have priority
    setImmediate(async () => {
      this.logger.debug('Running cron job to mark expired trip requests');

      const now = new Date();

      // Find all pending trip requests with departureDateMax in the past
      const expiredRequests = await this.tripRequestRepository.find({
        where: {
          status: TripRequestStatus.PENDING,
          departureDateMax: LessThan(now),
        },
        relations: ['passenger'],
      });

      if (expiredRequests.length === 0) {
        this.logger.debug('No expired trip requests found');
        return;
      }

      this.logger.log(
        `Found ${expiredRequests.length} expired trip requests to mark as expired`,
      );

      // Mark all expired requests
      await this.tripRequestRepository.update(
        {
          id: In(expiredRequests.map((r) => r.id)),
        },
        {
          status: TripRequestStatus.EXPIRED,
        },
      );

      this.logger.log(
        `Successfully marked ${expiredRequests.length} trip requests as expired`,
      );
    });
  }

  /**
   * Cron job to notify passengers about upcoming trip request expiration
   * Runs every 15 minutes to check for trip requests expiring in the next 30 minutes
   */
  @Cron('*/15 * * * *') // Every 15 minutes
  async notifyAboutUpcomingTripRequestExpiration() {
    // Use setImmediate to ensure HTTP requests have priority
    setImmediate(async () => {
      this.logger.debug(
        'Running cron job to notify about upcoming trip request expiration',
      );

      const now = new Date();
      const thirtyMinutesFromNow = new Date(now.getTime() + 30 * 60 * 1000); // 30 minutes from now

      // Find all pending trip requests expiring in the next 30 minutes that haven't been notified yet
      const requestsExpiringSoon = await this.tripRequestRepository.find({
        where: {
          status: TripRequestStatus.PENDING,
          departureDateMax: Between(now, thirtyMinutesFromNow),
          expirationNotificationSent: false,
        },
        relations: ['passenger'],
      });

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
          tripRequest.expirationNotificationSent = true;
          await this.tripRequestRepository.save(tripRequest);
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
    });
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
      (tripRequest.departureDateMax.getTime() - Date.now()) / (60 * 1000),
    );

    const title = '⏰ Votre demande de trajet expire bientôt';
    const body = `Votre demande de trajet ${tripRequest.departureLocation} → ${tripRequest.arrivalLocation} expire dans ${minutesUntilExpiration} minute(s). Vous pouvez la mettre à jour ou la laisser expirer.`;

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
