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
import { User } from '../users/entities/user.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { CreateTripRequestDto, CreateDriverOfferDto, AcceptDriverOfferDto } from './dto/trip-request.dto';
import { FileUploadService } from '../common/services/file-upload.service';
import { NotificationService } from '../notifications/notifications.service';
import { TripsService } from '../trips/trips.service';
import { BookingsService } from '../bookings/bookings.service';
import { BookingStatus } from '../bookings/entities/booking.entity';

export interface SanitizedUser {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  profilePicture: string | null;
}

export interface SanitizedVehicle {
  id: string;
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
  status: DriverOfferStatus;
  createdAt: Date;
}

export interface SanitizedDriverOfferWithTripRequest extends SanitizedDriverOffer {
  tripRequest: {
    id: string;
    departureLocation: string;
    arrivalLocation: string;
    departureDateMin: Date;
    departureDateMax: Date;
    numberOfSeats: number;
    maxPricePerSeat: number | null;
    status: TripRequestStatus;
    passenger: SanitizedUser;
  };
}

export interface SanitizedTripRequest {
  id: string;
  passenger: SanitizedUser;
  departureLocation: string;
  arrivalLocation: string;
  departureCoordinates: [number, number] | null;
  arrivalCoordinates: [number, number] | null;
  departureDateMin: Date;
  departureDateMax: Date;
  numberOfSeats: number;
  maxPricePerSeat: number | null;
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

@Injectable()
export class TripRequestsService {
  private readonly logger = new Logger(TripRequestsService.name);

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
  ) {}

  async create(passengerId: string, createTripRequestDto: CreateTripRequestDto): Promise<SanitizedTripRequest> {
    this.logger.log(`Creating trip request for passenger: ${passengerId}`);

    const passenger = await this.userRepository.findOne({ where: { id: passengerId } });
    if (!passenger) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    const { departureCoordinates, arrivalCoordinates, departureDateMin, departureDateMax, ...rest } = createTripRequestDto;

    // Validate dates
    const minDate = new Date(departureDateMin);
    const maxDate = new Date(departureDateMax);
    
    if (minDate >= maxDate) {
      throw new BadRequestException('La date de départ minimum doit être antérieure à la date maximum');
    }

    if (minDate < new Date()) {
      throw new BadRequestException('La date de départ minimum ne peut pas être dans le passé');
    }

    const tripRequest = this.tripRequestRepository.create({
      ...rest,
      passengerId,
      departurePoint: this.buildPointFromCoordinates(departureCoordinates),
      arrivalPoint: this.buildPointFromCoordinates(arrivalCoordinates),
      departureDateMin: minDate,
      departureDateMax: maxDate,
    });

    const saved = await this.tripRequestRepository.save(tripRequest);
    this.logger.log(`Trip request created: ${saved.id}`);
    
    // Notify all active drivers about the new trip request
    await this.notifyDriversAboutTripRequest(saved);
    
    return this.findOne(saved.id, passengerId);
  }

  private async notifyDriversAboutTripRequest(tripRequest: TripRequest): Promise<void> {
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
        this.logger.debug('No drivers with FCM tokens found (excluding passenger), skipping notifications');
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

      await this.notificationService.sendToMultiple(fcmTokens, title, body, data, driverIds);
      this.logger.log(`Notified ${fcmTokens.length} drivers about trip request ${tripRequest.id} (excluded passenger ${tripRequest.passengerId})`);
    } catch (error) {
      this.logger.error(`Error notifying drivers about trip request ${tripRequest.id}: ${error.message}`, error.stack);
      // Don't throw error, just log it - trip request creation should succeed even if notification fails
    }
  }

  async findAll(): Promise<SanitizedTripRequest[]> {
    this.logger.debug('Fetching all trip requests');

    const now = new Date();
    const tripRequests = await this.tripRequestRepository.find({
      relations: ['passenger', 'selectedDriver', 'selectedVehicle', 'driverOffers', 'driverOffers.driver', 'driverOffers.vehicle'],
      where: { 
        status: TripRequestStatus.PENDING,
        departureDateMax: MoreThan(now), // Exclure les demandes expirées
      },
      order: { createdAt: 'DESC' },
    });

    return Promise.all(tripRequests.map((tr) => this.sanitizeTripRequest(tr)));
  }

  async findOne(id: string, userId?: string): Promise<SanitizedTripRequest> {
    this.logger.debug(`Fetching trip request: ${id}`);

    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id },
      relations: ['passenger', 'selectedDriver', 'selectedVehicle', 'driverOffers', 'driverOffers.driver', 'driverOffers.vehicle'],
    });

    if (!tripRequest) {
      throw new NotFoundException('Demande de trajet non trouvée');
    }

    // Only passenger or drivers who made offers can see all offers
    if (userId && tripRequest.passengerId !== userId) {
      const hasOffer = tripRequest.driverOffers?.some((offer) => offer.driverId === userId);
      if (!hasOffer) {
        // Remove offers from other drivers
        tripRequest.driverOffers = tripRequest.driverOffers?.filter((offer) => offer.driverId === userId) || [];
      }
    }

    return this.sanitizeTripRequest(tripRequest);
  }

  async getOffersForTripRequest(tripRequestId: string, userId?: string): Promise<SanitizedDriverOffer[]> {
    this.logger.debug(`Fetching offers for trip request: ${tripRequestId}`);

    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId },
      relations: ['driverOffers', 'driverOffers.driver', 'driverOffers.vehicle'],
    });

    if (!tripRequest) {
      throw new NotFoundException('Demande de trajet non trouvée');
    }

    // Only passenger can see all offers
    if (userId && tripRequest.passengerId !== userId) {
      throw new ForbiddenException('Seul le passager peut voir toutes les offres');
    }

    if (!tripRequest.driverOffers || tripRequest.driverOffers.length === 0) {
      return [];
    }

    return Promise.all(tripRequest.driverOffers.map((offer) => this.sanitizeDriverOffer(offer)));
  }

  async findByPassenger(passengerId: string): Promise<SanitizedTripRequest[]> {
    this.logger.debug(`Fetching trip requests for passenger: ${passengerId}`);

    const now = new Date();
    const tripRequests = await this.tripRequestRepository.find({
      where: { 
        passengerId,
        departureDateMax: MoreThan(now), // Exclure les demandes expirées
      },
      relations: ['passenger', 'selectedDriver', 'selectedVehicle', 'driverOffers', 'driverOffers.driver', 'driverOffers.vehicle'],
      order: { createdAt: 'DESC' },
    });

    return Promise.all(tripRequests.map((tr) => this.sanitizeTripRequest(tr)));
  }

  async findByDriver(driverId: string): Promise<SanitizedDriverOfferWithTripRequest[]> {
    this.logger.debug(`Fetching driver offers for driver: ${driverId}`);

    const offers = await this.driverOfferRepository.find({
      where: { driverId },
      relations: ['driver', 'vehicle', 'tripRequest', 'tripRequest.passenger'],
      order: { createdAt: 'DESC' },
    });

    return Promise.all(offers.map((offer) => this.sanitizeDriverOfferWithTripRequest(offer)));
  }

  async createDriverOffer(
    driverId: string,
    tripRequestId: string,
    createDriverOfferDto: CreateDriverOfferDto,
  ): Promise<SanitizedDriverOffer> {
    this.logger.log(`Creating driver offer for trip request: ${tripRequestId} by driver: ${driverId}`);

    const driver = await this.userRepository.findOne({ where: { id: driverId } });
    if (!driver) {
      throw new NotFoundException('Conducteur non trouvé');
    }

    if (!driver.isDriver) {
      throw new BadRequestException('Vous devez être un conducteur pour faire une offre');
    }

    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId },
      relations: ['passenger'],
    });

    if (!tripRequest) {
      throw new NotFoundException('Demande de trajet non trouvée');
    }

    // Check if trip request is expired
    const now = new Date();
    if (tripRequest.departureDateMax < now) {
      throw new BadRequestException('Cette demande de trajet a expiré');
    }

    if (tripRequest.status !== TripRequestStatus.PENDING && tripRequest.status !== TripRequestStatus.OFFERS_RECEIVED) {
      throw new BadRequestException('Cette demande de trajet n\'accepte plus d\'offres');
    }

    if (tripRequest.passengerId === driverId) {
      throw new BadRequestException('Vous ne pouvez pas faire une offre sur votre propre demande');
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
      throw new BadRequestException('Vous avez déjà fait une offre pour cette demande');
    }

    const { proposedDepartureDate, vehicleId, ...rest } = createDriverOfferDto;
    const proposedDate = new Date(proposedDepartureDate);

    // Validate proposed date is within the range
    if (proposedDate < tripRequest.departureDateMin || proposedDate > tripRequest.departureDateMax) {
      throw new BadRequestException(
        `La date proposée doit être entre ${tripRequest.departureDateMin.toISOString()} et ${tripRequest.departureDateMax.toISOString()}`,
      );
    }

    // Validate price if maxPricePerSeat is set
    if (tripRequest.maxPricePerSeat !== null && createDriverOfferDto.pricePerSeat > tripRequest.maxPricePerSeat) {
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
        throw new BadRequestException('Véhicule non trouvé ou ne vous appartient pas');
      }

      if (!vehicle.isActive) {
        throw new BadRequestException('Le véhicule sélectionné n\'est pas actif');
      }
    }

    const offer = this.driverOfferRepository.create({
      ...rest,
      tripRequestId,
      driverId,
      vehicleId: vehicleId || null,
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
    await this.notifyPassengerAboutDriverOffer(tripRequest, offerWithRelations!);

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
        this.logger.debug(`Passenger ${tripRequest.passengerId} has no FCM token, skipping notification`);
        return;
      }

      const driverName = offer.driver ? `${offer.driver.firstName} ${offer.driver.lastName}` : 'Un conducteur';
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
      this.logger.log(`Notified passenger ${tripRequest.passengerId} about driver offer ${offer.id}`);
    } catch (error) {
      this.logger.error(`Error notifying passenger about driver offer ${offer.id}: ${error.message}`, error.stack);
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
        this.logger.debug(`Driver ${offer.driverId} has no FCM token, skipping notification`);
        return;
      }

      const passengerName = tripRequest.passenger ? `${tripRequest.passenger.firstName} ${tripRequest.passenger.lastName}` : 'Un passager';
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
      this.logger.log(`Notified driver ${offer.driverId} about offer acceptance ${offer.id}`);
    } catch (error) {
      this.logger.error(`Error notifying driver about offer acceptance ${offer.id}: ${error.message}`, error.stack);
      // Don't throw error, just log it - offer acceptance should succeed even if notification fails
    }
  }

  async acceptDriverOffer(passengerId: string, tripRequestId: string, acceptDto: AcceptDriverOfferDto): Promise<SanitizedTripRequest> {
    this.logger.log(`Accepting driver offer ${acceptDto.offerId} for trip request ${tripRequestId} by passenger ${passengerId}`);

    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId, passengerId },
      relations: ['passenger', 'driverOffers', 'driverOffers.driver', 'driverOffers.vehicle'],
    });

    if (!tripRequest) {
      throw new NotFoundException('Demande de trajet non trouvée ou vous n\'êtes pas le propriétaire');
    }

    if (tripRequest.status === TripRequestStatus.DRIVER_SELECTED) {
      throw new BadRequestException('Un driver a déjà été sélectionné pour cette demande');
    }

    if (tripRequest.status === TripRequestStatus.CANCELLED || tripRequest.status === TripRequestStatus.EXPIRED) {
      throw new BadRequestException('Cette demande n\'accepte plus d\'offres');
    }

    const offer = tripRequest.driverOffers?.find((o) => o.id === acceptDto.offerId);
    if (!offer) {
      throw new NotFoundException('Offre du conducteur non trouvée');
    }

    if (offer.status !== DriverOfferStatus.PENDING) {
      throw new BadRequestException('Cette offre n\'est plus disponible');
    }

    // Accept the offer
    offer.status = DriverOfferStatus.ACCEPTED;
    offer.acceptedAt = new Date();
    await this.driverOfferRepository.save(offer);

    // Reject all other pending offers
    const otherOffers = tripRequest.driverOffers?.filter(
      (o) => o.id !== acceptDto.offerId && o.status === DriverOfferStatus.PENDING,
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

    this.logger.log(`Driver offer ${acceptDto.offerId} accepted for trip request ${tripRequestId}`);

    // Notify the driver that their offer was accepted
    await this.notifyDriverAboutOfferAcceptance(tripRequest, offer);

    return this.findOne(tripRequestId, passengerId);
  }

  async startTripFromRequest(tripRequestId: string, driverId: string) {
    this.logger.log(`Starting trip from request ${tripRequestId} by driver ${driverId}`);

    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId },
      relations: ['passenger', 'selectedDriver', 'selectedVehicle'],
    });

    if (!tripRequest) {
      throw new NotFoundException('Demande de trajet non trouvée');
    }

    if (tripRequest.status !== TripRequestStatus.DRIVER_SELECTED) {
      throw new BadRequestException('Un driver doit être sélectionné avant de lancer le trajet');
    }

    if (tripRequest.selectedDriverId !== driverId) {
      throw new ForbiddenException('Vous n\'êtes pas le driver sélectionné pour cette demande');
    }

    if (tripRequest.tripId) {
      throw new BadRequestException('Un trajet a déjà été créé à partir de cette demande !');
    }

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

    // Get coordinates
    const departureCoordinates = this.pointToCoordinates(tripRequest.departurePoint);
    const arrivalCoordinates = this.pointToCoordinates(tripRequest.arrivalPoint);

    if (!departureCoordinates || !arrivalCoordinates) {
      throw new BadRequestException('Les coordonnées de départ ou d\'arrivée sont manquantes');
    }

    // Create Trip from TripRequest
    const trip = await this.tripsService.create(driverId, {
      departureLocation: tripRequest.departureLocation,
      arrivalLocation: tripRequest.arrivalLocation,
      departureCoordinates,
      arrivalCoordinates,
      departureDate: acceptedOffer.proposedDepartureDate.toISOString(),
      totalSeats: acceptedOffer.availableSeats,
      pricePerSeat: tripRequest.selectedPricePerSeat || 0,
      isFree: (tripRequest.selectedPricePerSeat || 0) === 0,
      vehicleId: tripRequest.selectedVehicleId || undefined,
      description: tripRequest.description || undefined,
    });

    // Create booking for the passenger automatically (ACCEPTED status)
    await this.bookingsService.create(tripRequest.passengerId, {
      tripId: trip.id,
      numberOfSeats: tripRequest.numberOfSeats,
    });

    // Accept the booking automatically
    const bookings = await this.bookingsService.findAllByTrip(trip.id, driverId);
    const passengerBooking = bookings.find((b) => b.passengerId === tripRequest.passengerId);
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

  async cancel(passengerId: string, tripRequestId: string): Promise<void> {
    this.logger.log(`Cancelling trip request ${tripRequestId} by passenger ${passengerId}`);

    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId, passengerId },
    });

    if (!tripRequest) {
      throw new NotFoundException('Demande de trajet non trouvée ou vous n\'êtes pas le propriétaire');
    }

    if (tripRequest.status === TripRequestStatus.DRIVER_SELECTED) {
      throw new BadRequestException('Vous ne pouvez pas annuler une demande pour laquelle un driver a été sélectionné');
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

  private buildPointFromCoordinates([longitude, latitude]: [number, number]): Point {
    return {
      type: 'Point',
      coordinates: [Number(longitude), Number(latitude)],
    };
  }

  private pointToCoordinates(point?: Point): [number, number] | null {
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

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      profilePicture: profilePicture || user.profilePicture,
    };
  }

  private async sanitizeVehicle(vehicle?: Vehicle): Promise<SanitizedVehicle | null> {
    if (!vehicle) {
      return null;
    }

    let photoUrl = vehicle.photoUrl;
    if (photoUrl) {
      photoUrl = await this.fileUploadService.getPresignedUrlIfS3Key(photoUrl) || photoUrl;
    }

    return {
      id: vehicle.id,
      brand: vehicle.brand,
      model: vehicle.model,
      color: vehicle.color,
      licensePlate: vehicle.licensePlate,
      photoUrl,
    };
  }

  private async sanitizeDriverOffer(offer: DriverOffer): Promise<SanitizedDriverOffer> {
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
      throw new Error(`Driver offer ${offer.id} has no trip request associated`);
    }

    if (!offer.tripRequest.passenger) {
      throw new Error(`Trip request ${offer.tripRequest.id} has no passenger associated`);
    }

    const driver = await this.sanitizeUser(offer.driver);
    if (!driver) {
      throw new Error(`Failed to sanitize driver for offer ${offer.id}`);
    }

    const passenger = await this.sanitizeUser(offer.tripRequest.passenger);
    if (!passenger) {
      throw new Error(`Failed to sanitize passenger for trip request ${offer.tripRequest.id}`);
    }

    return {
      id: offer.id,
      driver,
      vehicle: await this.sanitizeVehicle(offer.vehicle || undefined),
      proposedDepartureDate: offer.proposedDepartureDate,
      pricePerSeat: Number(offer.pricePerSeat),
      availableSeats: offer.availableSeats,
      message: offer.message,
      status: offer.status,
      createdAt: offer.createdAt,
      tripRequest: {
        id: offer.tripRequest.id,
        departureLocation: offer.tripRequest.departureLocation,
        arrivalLocation: offer.tripRequest.arrivalLocation,
        departureDateMin: offer.tripRequest.departureDateMin,
        departureDateMax: offer.tripRequest.departureDateMax,
        numberOfSeats: offer.tripRequest.numberOfSeats,
        maxPricePerSeat: offer.tripRequest.maxPricePerSeat ? Number(offer.tripRequest.maxPricePerSeat) : null,
        status: offer.tripRequest.status,
        passenger,
      },
    };
  }

  private async sanitizeTripRequest(tripRequest: TripRequest): Promise<SanitizedTripRequest> {
    if (!tripRequest.passenger) {
      throw new Error(`Trip request ${tripRequest.id} has no passenger associated`);
    }

    const passenger = await this.sanitizeUser(tripRequest.passenger);
    if (!passenger) {
      throw new Error(`Failed to sanitize passenger for trip request ${tripRequest.id}`);
    }

    return {
      id: tripRequest.id,
      passenger,
      departureLocation: tripRequest.departureLocation,
      arrivalLocation: tripRequest.arrivalLocation,
      departureCoordinates: this.pointToCoordinates(tripRequest.departurePoint),
      arrivalCoordinates: this.pointToCoordinates(tripRequest.arrivalPoint),
      departureDateMin: tripRequest.departureDateMin,
      departureDateMax: tripRequest.departureDateMax,
      numberOfSeats: tripRequest.numberOfSeats,
      maxPricePerSeat: tripRequest.maxPricePerSeat ? Number(tripRequest.maxPricePerSeat) : null,
      description: tripRequest.description,
      status: tripRequest.status,
      selectedDriver: await this.sanitizeUser(tripRequest.selectedDriver || undefined),
      selectedVehicle: await this.sanitizeVehicle(tripRequest.selectedVehicle || undefined),
      selectedPricePerSeat: tripRequest.selectedPricePerSeat ? Number(tripRequest.selectedPricePerSeat) : null,
      selectedAt: tripRequest.selectedAt,
      tripId: tripRequest.tripId,
      driverOffers: tripRequest.driverOffers
        ? await Promise.all(tripRequest.driverOffers.map((offer) => this.sanitizeDriverOffer(offer)))
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

    this.logger.log(`Found ${expiredRequests.length} expired trip requests to mark as expired`);

    // Mark all expired requests
    await this.tripRequestRepository.update(
      {
        id: In(expiredRequests.map((r) => r.id)),
      },
      {
        status: TripRequestStatus.EXPIRED,
      },
    );

    this.logger.log(`Successfully marked ${expiredRequests.length} trip requests as expired`);
  }

  /**
   * Cron job to notify passengers about upcoming trip request expiration
   * Runs every 15 minutes to check for trip requests expiring in the next 30 minutes
   */
  @Cron('*/15 * * * *') // Every 15 minutes
  async notifyAboutUpcomingTripRequestExpiration() {
    this.logger.debug('Running cron job to notify about upcoming trip request expiration');
    
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

    this.logger.log(`Found ${requestsExpiringSoon.length} trip requests expiring soon`);

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
  }

  /**
   * Notify passenger about upcoming trip request expiration
   */
  private async notifyPassengerAboutUpcomingExpiration(tripRequest: TripRequest): Promise<void> {
    const passenger = tripRequest.passenger;
    
    if (!passenger || !passenger.fcmToken) {
      this.logger.debug(`Passenger ${tripRequest.passengerId} has no FCM token, skipping notification`);
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

