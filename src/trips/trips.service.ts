import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Point, LessThan, MoreThan, In, Between, Brackets, Not, IsNull } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Trip, TripStatus } from './entities/trip.entity';
import {
  RecurringTripTemplate,
  RecurringTripTemplateStatus,
} from './entities/recurring-trip-template.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { TripRequest } from '../trip-requests/entities/trip-request.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import {
  CreateTripDto,
  CreateRecurringTripDto,
  SearchTripsDto,
  UpdateTripDto,
  DriverEmergencyContactsDto,
} from './dto/trip.dto';
import { CacheService } from '../common/services/cache.service';
import { FileUploadService } from '../common/services/file-upload.service';
import { NotificationService } from '../notifications/notifications.service';
import { Rating } from '../ratings/entities/rating.entity';
import { EmergencyContact } from '../safety/entities/emergency-contact.entity';
import { MessagingService } from '../messaging/messaging.service';

export type Coordinates = [number, number] | null;

export interface SanitizedUser {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  profilePicture: string | null;
  role: User['role'];
  status: User['status'];
  isDriver: boolean;
  averageRating: number | null;
  totalRatings: number;
}

interface UserRatingSummary {
  averageRating: number | null;
  totalRatings: number;
}

export type SanitizedBooking = Omit<Booking, 'trip' | 'passenger' | 'messages'> & {
  passenger: SanitizedUser | null;
};

export interface SanitizedVehicle {
  id: string;
  brand: string;
  model: string;
  color: string;
  licensePlate: string;
  photoUrl: string | null;
}

export type SanitizedTrip = Omit<Trip, 'driver' | 'bookings' | 'departurePoint' | 'arrivalPoint' | 'vehicle'> & {
  driver: SanitizedUser | null;
  bookings: SanitizedBooking[];
  departureCoordinates: Coordinates;
  arrivalCoordinates: Coordinates;
  vehicle: SanitizedVehicle | null;
};

interface RecurringTripFutureMeta {
  nextOccurrenceDate: string | null;
  upcomingGeneratedTripsCount: number;
}

export type SanitizedRecurringTripTemplate = Omit<
  RecurringTripTemplate,
  'departurePoint' | 'arrivalPoint' | 'vehicle' | 'departureTimeMinutes'
> & {
  departureCoordinates: Coordinates;
  arrivalCoordinates: Coordinates;
  departureTime: string;
  vehicle: SanitizedVehicle | null;
  nextOccurrenceDate: string | null;
  upcomingGeneratedTripsCount: number;
};

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);
  private readonly CACHE_TTL = 300; // 5 minutes
  private readonly RECURRING_GENERATION_WINDOW_DAYS = 14;

  constructor(
    @InjectRepository(Trip)
    private tripRepository: Repository<Trip>,
    @InjectRepository(RecurringTripTemplate)
    private recurringTripTemplateRepository: Repository<RecurringTripTemplate>,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Vehicle)
    private vehicleRepository: Repository<Vehicle>,
    @InjectRepository(TripRequest)
    private tripRequestRepository: Repository<TripRequest>,
    @InjectRepository(KycDocument)
    private kycDocumentRepository: Repository<KycDocument>,
    @InjectRepository(Rating)
    private ratingRepository: Repository<Rating>,
    @InjectRepository(EmergencyContact)
    private emergencyContactRepository: Repository<EmergencyContact>,
    private cacheService: CacheService,
    private fileUploadService: FileUploadService,
    private notificationService: NotificationService,
    private messagingService: MessagingService,
  ) { }

  async create(
    driverId: string,
    createTripDto: CreateTripDto,
    options?: { isPrivate?: boolean; tripRequestId?: string },
  ): Promise<SanitizedTrip> {
    const isFree = createTripDto.isFree ?? createTripDto.pricePerSeat === 0;
    const pricePerSeat = isFree ? 0 : createTripDto.pricePerSeat;

    const tripType = isFree ? 'gratuit' : 'payant';
    this.logger.log(
      `Creating ${tripType} trip for user: ${driverId} from ${createTripDto.departureLocation} to ${createTripDto.arrivalLocation} (price: ${pricePerSeat} CDF)`,
    );

    const {
      departureCoordinates,
      arrivalCoordinates,
      departureDate,
      vehicleId,
      ...baseTripData
    } = createTripDto;

    const { vehicle } = await this.resolvePublishingContext(driverId, vehicleId || null);

    const trip = this.tripRepository.create({
      ...baseTripData,
      driverId,
      vehicleId: vehicle?.id ?? null,
      departureDate: new Date(departureDate),
      departurePoint: this.buildPointFromCoordinates(departureCoordinates),
      arrivalPoint: this.buildPointFromCoordinates(arrivalCoordinates),
      isFree,
      pricePerSeat,
      totalSeats: baseTripData.totalSeats,
      availableSeats: baseTripData.totalSeats,
      isPrivate: options?.isPrivate ?? false,
      tripRequestId: options?.tripRequestId || null,
      recurringTemplateId: null,
      recurringOccurrenceDate: null,
    });

    const savedTrip = await this.tripRepository.save(trip);
    await this.invalidateTripCaches();

    this.logger.log(`Trip created successfully: ${savedTrip.id} by user ${driverId}`);
    return this.findOne(savedTrip.id);
  }

  async findAll(): Promise<SanitizedTrip[]> {
    this.logger.debug('Fetching all trips');

    const cacheKey = CacheService.getTripsListKey('all');
    const cached = await this.cacheService.get<SanitizedTrip[]>(cacheKey);

    if (cached) {
      this.logger.debug(`Returning ${cached.length} trips from cache`);
      return cached;
    }

    const now = new Date();
    // Include PENDING trips with future departure dates OR ACTIVE trips with available seats
    // Exclude private trips (created from trip requests)
    const trips = await this.tripRepository.find({
      where: [
        {
          status: TripStatus.PENDING,
          departureDate: MoreThan(now),
          isPrivate: false, // Exclude private trips
        },
        {
          status: TripStatus.ACTIVE,
          departureDate: MoreThan(now),
          availableSeats: MoreThan(0),
          isPrivate: false, // Exclude private trips
        },
      ],
      relations: ['driver', 'vehicle', 'bookings', 'bookings.passenger'],
      order: {
        departureDate: 'ASC',
      },
    });

    const userRatingsMap = await this.buildUserRatingsMap(this.collectTripUserIds(trips));
    const sanitized = await Promise.all(
      trips.map((trip) => this.sanitizeTrip(trip, userRatingsMap)),
    );

    await this.cacheService.set(cacheKey, sanitized, this.CACHE_TTL);
    this.logger.log(`Fetched ${trips.length} trips from database (${trips.filter(t => t.status === TripStatus.PENDING).length} pending, ${trips.filter(t => t.status === TripStatus.ACTIVE).length} active)`);
    return sanitized;
  }

  async findAllTrips(): Promise<SanitizedTrip[]> {
    this.logger.debug('Fetching all trips of zwanga ended or none');

    const cacheKey = CacheService.getTripsListKey('allTrips');
    const cached = await this.cacheService.get<SanitizedTrip[]>(cacheKey);

    if (cached) {
      this.logger.debug(`Returning ${cached.length} trips from cache`);
      return cached;
    }

    const trips = await this.tripRepository.find({
      relations: ['driver', 'vehicle', 'bookings', 'bookings.passenger'],
      order: {
        departureDate: 'ASC',
      },
    });

    const userRatingsMap = await this.buildUserRatingsMap(this.collectTripUserIds(trips));
    const sanitized = await Promise.all(
      trips.map((trip) => this.sanitizeTrip(trip, userRatingsMap)),
    );

    await this.cacheService.set(cacheKey, sanitized, this.CACHE_TTL);
    this.logger.log(`Fetched ${trips.length} trips of zwanga from database (${trips.filter(t => t.status === TripStatus.PENDING).length} pending, ${trips.filter(t => t.status === TripStatus.ACTIVE).length} active)`);
    return sanitized;
  }

  async search(searchTripsDto: SearchTripsDto): Promise<SanitizedTrip[]> {
    this.logger.log(`Searching trips with filters: ${JSON.stringify(searchTripsDto)}`);

    const now = new Date();
    const queryBuilder = this.tripRepository
      .createQueryBuilder('trip')
      .leftJoinAndSelect('trip.driver', 'driver')
      .leftJoinAndSelect('trip.vehicle', 'vehicle')
      .leftJoinAndSelect('trip.bookings', 'bookings')
      .leftJoinAndSelect('bookings.passenger', 'bookingPassenger')
      .where(
        new Brackets((qb) => {
          qb.where('trip.isPrivate = :isPrivate', { isPrivate: false })
            .andWhere('trip.departureDate > :now', { now })
            .andWhere(
              new Brackets((qb2) => {
                qb2.where('trip.status = :pendingStatus', { pendingStatus: TripStatus.PENDING })
                  .orWhere(
                    new Brackets((qb3) => {
                      qb3.where('trip.status = :activeStatus', { activeStatus: TripStatus.ACTIVE })
                        .andWhere('trip.availableSeats > 0');
                    })
                  );
              })
            );
        }),
      );

    if (searchTripsDto.departureDate) {
      const date = new Date(searchTripsDto.departureDate);
      const startOfDay = new Date(date.setHours(0, 0, 0, 0));
      const endOfDay = new Date(date.setHours(23, 59, 59, 999));
      queryBuilder.andWhere('trip.departureDate BETWEEN :start AND :end', {
        start: startOfDay,
        end: endOfDay,
      });
    }

    if (searchTripsDto.keywords?.trim()) {
      const keywords = Array.from(
        new Set(
          searchTripsDto.keywords
            .trim()
            .split(/\s+/)
            .map((keyword) => keyword.trim())
            .filter(Boolean),
        ),
      ).slice(0, 8);

      keywords.forEach((keyword, index) => {
        const keywordParam = `keyword${index}`;
        queryBuilder.andWhere(
          new Brackets((qb) => {
            qb.where(`trip.departureLocation ILIKE :${keywordParam}`)
              .orWhere(`trip.arrivalLocation ILIKE :${keywordParam}`);
          }),
          { [keywordParam]: `%${keyword}%` },
        );
      });
    }

    if (searchTripsDto.departureLocation) {
      queryBuilder.andWhere('trip.departureLocation ILIKE :departureLocation', {
        departureLocation: `%${searchTripsDto.departureLocation}%`,
      });
    }

    if (searchTripsDto.arrivalLocation) {
      queryBuilder.andWhere('trip.arrivalLocation ILIKE :arrivalLocation', {
        arrivalLocation: `%${searchTripsDto.arrivalLocation}%`,
      });
    }

    if (searchTripsDto.minSeats) {
      queryBuilder.andWhere('trip.availableSeats >= :minSeats', {
        minSeats: searchTripsDto.minSeats,
      });
    }

    // Filter by maximum price (includes free trips when maxPrice >= 0)
    if (searchTripsDto.maxPrice !== undefined) {
      queryBuilder.andWhere('trip.pricePerSeat <= :maxPrice', {
        maxPrice: searchTripsDto.maxPrice,
      });
    }

    // Filter by free trips
    if (searchTripsDto.isFree !== undefined) {
      queryBuilder.andWhere('trip.isFree = :isFree', {
        isFree: searchTripsDto.isFree,
      });
    }

    // If coordinates are provided, calculate distance (simplified - in production use PostGIS)
    const hasDepartureCoords =
      Array.isArray(searchTripsDto.departureCoordinates) &&
      searchTripsDto.departureCoordinates.length === 2;

    let depLng: number | undefined;
    let depLat: number | undefined;

    if (hasDepartureCoords) {
      [depLng, depLat] = searchTripsDto.departureCoordinates as [number, number];
      const departureRadiusMeters =
        (searchTripsDto.departureRadiusKm ?? 50) * 1000;

      queryBuilder.andWhere(
        `ST_DWithin(
          trip.departurePoint,
          ST_SetSRID(ST_MakePoint(:depLng, :depLat), 4326)::geography,
          :depRadius
        )`,
        {
          depLat,
          depLng,
          depRadius: departureRadiusMeters,
        },
      );
    }

    const hasArrivalCoords =
      Array.isArray(searchTripsDto.arrivalCoordinates) &&
      searchTripsDto.arrivalCoordinates.length === 2;

    let arrLng: number | undefined;
    let arrLat: number | undefined;

    if (hasArrivalCoords) {
      [arrLng, arrLat] = searchTripsDto.arrivalCoordinates as [number, number];
      const arrivalRadiusMeters =
        (searchTripsDto.arrivalRadiusKm ?? 50) * 1000;

      queryBuilder.andWhere(
        `ST_DWithin(
          trip.arrivalPoint,
          ST_SetSRID(ST_MakePoint(:arrLng, :arrLat), 4326)::geography,
          :arrRadius
        )`,
        {
          arrLat,
          arrLng,
          arrRadius: arrivalRadiusMeters,
        },
      );
    }

    if (hasDepartureCoords && depLng !== undefined && depLat !== undefined) {
      queryBuilder.orderBy(
        `ST_Distance(
          trip.departurePoint,
          ST_SetSRID(ST_MakePoint(:depLng, :depLat), 4326)::geography
        )`,
        'ASC',
      );
    } else if (hasArrivalCoords && arrLng !== undefined && arrLat !== undefined) {
      queryBuilder.orderBy(
        `ST_Distance(
          trip.arrivalPoint,
          ST_SetSRID(ST_MakePoint(:arrLng, :arrLat), 4326)::geography
        )`,
        'ASC',
      );
    } else {
      queryBuilder.orderBy('trip.departureDate', 'ASC');
    }

    const results = await queryBuilder.getMany();
    const userRatingsMap = await this.buildUserRatingsMap(this.collectTripUserIds(results));
    const sanitized = await Promise.all(
      results.map((trip) => this.sanitizeTrip(trip, userRatingsMap)),
    );
    this.logger.log(`Trip search returned ${sanitized.length} results`);
    return sanitized;
  }

  async findOne(id: string): Promise<SanitizedTrip> {
    this.logger.debug(`Fetching trip: ${id}`);

    const cacheKey = CacheService.getTripKey(id);
    const cached = await this.cacheService.get<SanitizedTrip>(cacheKey);

    if (cached) {
      this.logger.debug(`Trip ${id} returned from cache`);
      return cached;
    }

    const trip = await this.tripRepository.findOne({
      where: { id },
      relations: ['driver', 'driver.vehicles', 'vehicle', 'bookings', 'bookings.passenger'],
    });

    if (!trip) {
      this.logger.warn(`Trip not found: ${id}`);
      throw new NotFoundException('Trajet non trouve');
    }

    const userRatingsMap = await this.buildUserRatingsMap(this.collectTripUserIds([trip]));
    const sanitized = await this.sanitizeTrip(trip, userRatingsMap);
    await this.cacheService.set(cacheKey, sanitized, this.CACHE_TTL);
    this.logger.debug(`Trip ${id} fetched from database`);
    return sanitized;
  }

  async findByDriver(driverId: string): Promise<SanitizedTrip[]> {
    this.logger.debug(`Fetching trips for driver: ${driverId}`);

    const trips = await this.tripRepository.find({
      where: { driverId },
      relations: ['vehicle', 'bookings', 'bookings.passenger', 'driver'],
      order: { departureDate: 'DESC' },
    });

    const userRatingsMap = await this.buildUserRatingsMap(this.collectTripUserIds(trips));
    const sanitized = trips.map((trip) => this.sanitizeTrip(trip, userRatingsMap));

    this.logger.debug(`Found ${trips.length} trips for driver ${driverId}`);
    const sanitizedResults = await Promise.all(sanitized);
    return sanitizedResults;
  }
  async createRecurring(
    driverId: string,
    createRecurringTripDto: CreateRecurringTripDto,
  ): Promise<SanitizedRecurringTripTemplate> {
    this.logger.log(
      `Creating recurring trip template for user ${driverId} from ${createRecurringTripDto.departureLocation} to ${createRecurringTripDto.arrivalLocation}`,
    );

    const { vehicle } = await this.resolvePublishingContext(
      driverId,
      createRecurringTripDto.vehicleId,
      true,
    );

    if (!vehicle) {
      throw new BadRequestException('Un vehicule actif est requis pour creer un trajet recurrent');
    }

    const startDate = this.parseDateOnly(createRecurringTripDto.startDate);
    const endDate = createRecurringTripDto.endDate
      ? this.parseDateOnly(createRecurringTripDto.endDate)
      : null;

    if (endDate && endDate < startDate) {
      throw new BadRequestException('La date de fin doit etre posterieure a la date de debut');
    }

    const weekdays = this.normalizeWeekdays(createRecurringTripDto.weekdays);
    const departureTimeMinutes = this.parseTimeToMinutes(createRecurringTripDto.departureTime);
    const isFree =
      createRecurringTripDto.isFree ?? createRecurringTripDto.pricePerSeat === 0;
    const pricePerSeat = isFree ? 0 : createRecurringTripDto.pricePerSeat;

    const template = this.recurringTripTemplateRepository.create({
      driverId,
      vehicleId: vehicle.id,
      departureLocation: createRecurringTripDto.departureLocation,
      departurePoint: this.buildPointFromCoordinates(
        createRecurringTripDto.departureCoordinates,
      ),
      arrivalLocation: createRecurringTripDto.arrivalLocation,
      arrivalPoint: this.buildPointFromCoordinates(createRecurringTripDto.arrivalCoordinates),
      departureTimeMinutes,
      weekdays,
      startDate: this.formatDateOnly(startDate),
      endDate: endDate ? this.formatDateOnly(endDate) : null,
      totalSeats: createRecurringTripDto.totalSeats,
      pricePerSeat,
      isFree,
      description: createRecurringTripDto.description?.trim() || null,
      status: RecurringTripTemplateStatus.ACTIVE,
      lastGeneratedDate: null,
    });

    const savedTemplate = await this.recurringTripTemplateRepository.save(template);
    await this.generateTripsForTemplate(savedTemplate);

    this.logger.log(`Recurring trip template ${savedTemplate.id} created successfully`);
    return this.findRecurringById(savedTemplate.id, driverId);
  }

  async findRecurringByDriver(driverId: string): Promise<SanitizedRecurringTripTemplate[]> {
    this.logger.debug(`Fetching recurring trip templates for driver: ${driverId}`);

    const templates = await this.recurringTripTemplateRepository.find({
      where: { driverId },
      relations: ['vehicle'],
      order: { updatedAt: 'DESC' },
    });

    const futureMeta = await this.buildRecurringTripFutureMeta(templates);
    return Promise.all(
      templates.map((template) =>
        this.sanitizeRecurringTripTemplate(template, futureMeta.get(template.id)),
      ),
    );
  }

  async pauseRecurring(
    templateId: string,
    driverId: string,
  ): Promise<SanitizedRecurringTripTemplate> {
    const template = await this.findRecurringTemplateEntity(templateId, driverId);

    if (template.status === RecurringTripTemplateStatus.PAUSED) {
      return this.sanitizeRecurringTripTemplate(
        template,
        (await this.buildRecurringTripFutureMeta([template])).get(template.id),
      );
    }

    template.status = RecurringTripTemplateStatus.PAUSED;
    await this.recurringTripTemplateRepository.save(template);

    return this.findRecurringById(template.id, driverId);
  }

  async resumeRecurring(
    templateId: string,
    driverId: string,
  ): Promise<SanitizedRecurringTripTemplate> {
    const template = await this.findRecurringTemplateEntity(templateId, driverId);

    if (template.status !== RecurringTripTemplateStatus.ACTIVE) {
      template.status = RecurringTripTemplateStatus.ACTIVE;
      await this.recurringTripTemplateRepository.save(template);
    }

    await this.generateTripsForTemplate(template);
    return this.findRecurringById(template.id, driverId);
  }

  /**
   * Permet au passager qui a créé la demande de trajet d'autoriser que le trajet devienne public
   * Le conducteur doit avoir passé le KYC et avoir au moins un véhicule actif pour que le trajet soit effectivement publié
   */
  async makeTripPublic(tripId: string, userId: string): Promise<SanitizedTrip> {
    this.logger.log(`Making trip ${tripId} public by user ${userId}`);

    const trip = await this.tripRepository.findOne({
      where: { id: tripId },
    });

    if (!trip) {
      throw new NotFoundException('Trajet non trouve');
    }

    if (!trip.isPrivate) {
      throw new BadRequestException('Ce trajet est déjà public');
    }

    if (!trip.tripRequestId) {
      throw new BadRequestException('Ce trajet n\'a pas été créé à partir d\'une demande de trajet');
    }

    // Vérifier que l'utilisateur est le passager qui a créé la demande de trajet
    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: trip.tripRequestId },
      select: ['id', 'passengerId'],
    });

    if (!tripRequest) {
      throw new NotFoundException('Demande de Trajet non trouvee');
    }

    // Seul le passager qui a créé la demande peut autoriser la publication
    if (tripRequest.passengerId !== userId) {
      throw new ForbiddenException('Seul le passager qui a créé la demande de trajet peut autoriser que le trajet devienne public. Vous n\'êtes pas autorisé à effectuer cette action.');
    }

    // Vérifier que le conducteur du trajet a les prérequis (KYC + véhicules)
    const driver = await this.userRepository.findOne({
      where: { id: trip.driverId },
      relations: ['vehicles'],
      select: ['id', 'role', 'isDriver', 'status'],
    });

    if (!driver) {
      throw new NotFoundException('Conducteur du Trajet non trouve');
    }

    // Vérifier que le conducteur a passé le KYC (status ACTIVE)
    if (driver.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Le conducteur du trajet doit avoir passé la vérification KYC (compte actif) pour que le trajet puisse être rendu public.');
    }

    // Vérifier que le KYC est approuvé
    const kycDocument = await this.kycDocumentRepository.findOne({
      where: { userId: trip.driverId },
      select: ['id', 'status'],
    });

    if (!kycDocument || kycDocument.status !== KycStatus.APPROVED) {
      throw new BadRequestException('Le conducteur du trajet doit avoir un KYC approuvé pour que le trajet puisse être rendu public.');
    }

    // Vérifier que le conducteur a au moins un véhicule actif
    const activeVehicles = driver.vehicles?.filter((v) => v.isActive) || [];
    if (activeVehicles.length === 0) {
      throw new BadRequestException('Le conducteur du trajet doit avoir au moins un véhicule actif pour que le trajet puisse être rendu public.');
    }

    // Rendre le trajet public
    trip.isPrivate = false;
    await this.tripRepository.save(trip);

    // Invalider le cache
    await this.cacheService.del(CacheService.getTripKey(tripId));
    await this.cacheService.del(CacheService.getTripsListKey());
    await this.cacheService.del(CacheService.getTripsListKey('all'));

    this.logger.log(`Trip ${tripId} is now public`);

    return this.findOne(tripId);
  }

  async update(id: string, driverId: string, updateTripDto: UpdateTripDto): Promise<SanitizedTrip> {
    this.logger.log(`Updating trip ${id} by driver ${driverId}`);

    const trip = await this.tripRepository.findOne({
      where: { id, driverId },
    });

    if (!trip) {
      this.logger.warn(`Trip update failed: Trip ${id} not found for driver ${driverId}`);
      throw new NotFoundException('Trajet non trouve');
    }
    if (updateTripDto.status === TripStatus.COMPLETED && trip.status !== TripStatus.COMPLETED) {
      return this.completeTrip(id, driverId);
    }

    const {
      departureDate,
      departureCoordinates,
      arrivalCoordinates,
      vehicleId,
      isFree,
      pricePerSeat,
      totalSeats,
      ...restPayload
    } = updateTripDto;

    if (departureDate) {
      trip.departureDate = new Date(departureDate);
    }

    if (departureCoordinates) {
      trip.departurePoint = this.buildPointFromCoordinates(departureCoordinates);
    }

    if (arrivalCoordinates) {
      trip.arrivalPoint = this.buildPointFromCoordinates(arrivalCoordinates);
    }

    // Synchronize isFree with pricePerSeat
    if (isFree !== undefined || pricePerSeat !== undefined) {
      const newIsFree = isFree !== undefined
        ? isFree
        : (pricePerSeat !== undefined ? pricePerSeat === 0 : trip.isFree);
      const newPricePerSeat = newIsFree
        ? 0
        : (pricePerSeat !== undefined ? pricePerSeat : trip.pricePerSeat);

      trip.isFree = newIsFree;
      trip.pricePerSeat = newPricePerSeat;
    }

    // Validate and update vehicle if provided
    if (vehicleId !== undefined) {
      if (vehicleId === null) {
        // Allow removing vehicle association
        trip.vehicleId = null;
      } else {
        const vehicle = await this.vehicleRepository.findOne({
          where: { id: vehicleId, ownerId: driverId },
        });

        if (!vehicle) {
          this.logger.warn(
            `Trip update failed: Vehicle ${vehicleId} not found or does not belong to driver ${driverId}`,
          );
          throw new BadRequestException(
            'Véhicule non trouvé ou ne vous appartient pas',
          );
        }

        if (!vehicle.isActive) {
          this.logger.warn(
            `Trip update failed: Vehicle ${vehicleId} is not active`,
          );
          throw new BadRequestException('Le véhicule sélectionné n\'est pas actif');
        }

        trip.vehicleId = vehicleId;
      }
    }

    // Gérer totalSeats et recalculer availableSeats si nécessaire
    if (totalSeats !== undefined && totalSeats !== (trip.totalSeats ?? trip.availableSeats)) {
      const oldTotalSeats = trip.totalSeats ?? trip.availableSeats; // Utiliser availableSeats comme fallback si totalSeats est null
      const oldAvailableSeats = trip.availableSeats;
      trip.totalSeats = totalSeats;

      // Si totalSeats change, recalculer availableSeats
      // availableSeats = totalSeats - (oldTotalSeats - oldAvailableSeats)
      // = totalSeats - réservations acceptées
      const bookedSeats = oldTotalSeats - oldAvailableSeats;
      trip.availableSeats = Math.max(0, totalSeats - bookedSeats);

      this.logger.log(
        `Updated trip ${id} totalSeats: ${oldTotalSeats} -> ${totalSeats}, availableSeats recalculated: ${oldAvailableSeats} -> ${trip.availableSeats} (booked seats: ${bookedSeats})`,
      );
    }

    Object.assign(trip, restPayload);
    const updatedTrip = await this.tripRepository.save(trip);

    // Invalidate cache
    await this.cacheService.del(CacheService.getTripKey(id));
    await this.cacheService.del(CacheService.getTripsListKey());
    await this.cacheService.del(CacheService.getTripsListKey('all'));
    await this.cacheService.del(CacheService.getTripsListKey('allTrips'));

    this.logger.log(`Trip ${id} updated successfully`);
    return this.findOne(id);
  }

  async setDriverEmergencyContacts(
    tripId: string,
    driverId: string,
    dto: DriverEmergencyContactsDto,
  ): Promise<{
    tripId: string;
    emergencyContactIds: string[];
    contacts: Array<{ id: string; name: string; phone: string }>;
  }> {
    const trip = await this.tripRepository.findOne({
      where: { id: tripId, driverId },
    });

    if (!trip) {
      throw new NotFoundException('Trajet non trouve');
    }

    const selectedContacts = await this.emergencyContactRepository.find({
      where: {
        userId: driverId,
        isActive: true,
        id: In(dto.emergencyContactIds),
      },
    });

    if (selectedContacts.length !== dto.emergencyContactIds.length) {
      throw new BadRequestException(
        "Certains contacts d'urgence selectionnes sont introuvables ou inactifs",
      );
    }

    trip.driverSafetyEmergencyContactIds = selectedContacts.map((contact) => contact.id);
    await this.tripRepository.save(trip);

    await this.cacheService.del(CacheService.getTripKey(tripId));

    return {
      tripId: trip.id,
      emergencyContactIds: trip.driverSafetyEmergencyContactIds,
      contacts: selectedContacts.map((contact) => ({
        id: contact.id,
        name: contact.name,
        phone: contact.phone,
      })),
    };
  }

  async completeTrip(tripId: string, driverId: string): Promise<SanitizedTrip> {
    this.logger.log(`Completing trip ${tripId} by driver ${driverId}`);

    const trip = await this.tripRepository.findOne({
      where: { id: tripId, driverId },
      relations: ['driver', 'bookings', 'bookings.passenger', 'vehicle'],
    });

    if (!trip) {
      throw new NotFoundException('Trajet non trouve ou vous n\'etes pas le conducteur');
    }

    if (trip.status !== TripStatus.ACTIVE) {
      throw new BadRequestException(
        `Impossible de terminer le trajet. Statut actuel : ${trip.status}`,
      );
    }

    trip.status = TripStatus.COMPLETED;
    trip.completedAt = new Date();
    await this.tripRepository.save(trip);

    await this.cacheService.del(CacheService.getTripKey(tripId));
    await this.cacheService.del(CacheService.getTripsListKey());
    await this.cacheService.del(CacheService.getTripsListKey('all'));

    await this.notifyDriverEmergencyContacts(trip, 'trip_completed');

    return this.findOne(tripId);
  }

  async remove(id: string, driverId: string): Promise<void> {
    this.logger.log(`Deleting trip ${id} by driver ${driverId}`);

    const trip = await this.tripRepository.findOne({
      where: { id, driverId },
      relations: ['bookings'],
    });

    if (!trip) {
      this.logger.warn(`Trip deletion failed: Trip ${id} not found for driver ${driverId}`);
      throw new NotFoundException('Trajet non trouve');
    }

    // Check if trip is completed or expired
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const isExpired = trip.status === TripStatus.PENDING && trip.departureDate < twoHoursAgo;
    const isCompleted = trip.status === TripStatus.COMPLETED;
    const isCancelled = trip.status === TripStatus.CANCELLED;

    // Only allow deletion of completed, cancelled, or expired trips
    if (!isCompleted && !isCancelled && !isExpired) {
      this.logger.warn(
        `Trip deletion failed: Trip ${id} is not completed, cancelled, or expired (status: ${trip.status})`,
      );
      throw new BadRequestException(
        'Vous ne pouvez supprimer que les trajets terminés, annulés ou expirés',
      );
    }

    // If trip has bookings, we need to handle them
    if (trip.bookings && trip.bookings.length > 0) {
      this.logger.log(
        `Trip ${id} has ${trip.bookings.length} bookings. Handling them before deletion.`,
      );

      // Get all booking IDs
      const bookingIds = trip.bookings.map((booking) => booking.id);

      // Delete all bookings associated with this trip
      // This will also handle cascade deletion of related messages if configured
      await this.bookingRepository.delete({ tripId: id });

      this.logger.log(`Deleted ${bookingIds.length} bookings for trip ${id}`);
    }

    // Now delete the trip
    await this.tripRepository.remove(trip);

    // Invalidate cache
    await this.cacheService.del(CacheService.getTripKey(id));
    await this.cacheService.del(CacheService.getTripsListKey());
    await this.cacheService.del(CacheService.getTripsListKey('all'));

    this.logger.log(`Trip ${id} deleted successfully`);
  }

  async startTrip(tripId: string, driverId: string): Promise<SanitizedTrip> {
    this.logger.log(`Starting trip ${tripId} by driver ${driverId}`);

    const trip = await this.tripRepository.findOne({
      where: { id: tripId, driverId },
      relations: ['bookings', 'bookings.passenger', 'driver', 'vehicle'],
    });

    if (!trip) {
      this.logger.warn(`Trip start failed: Trip ${tripId} not found for driver ${driverId}`);
      throw new NotFoundException('Trajet non trouve ou vous n\'êtes pas le conducteur');
    }

    if (trip.status !== TripStatus.PENDING) {
      this.logger.warn(`Trip start failed: Trip ${tripId} is not in PENDING status (current: ${trip.status})`);
      throw new BadRequestException(`Impossible de démarrer le trajet. Statut actuel : ${trip.status}`);
    }

    // Calculate total accepted seats
    const acceptedBookings = trip.bookings?.filter(
      (booking) => booking.status === BookingStatus.ACCEPTED,
    ) || [];
    const totalAcceptedSeats = acceptedBookings.reduce(
      (sum, booking) => sum + booking.numberOfSeats,
      0,
    );
    const hasAvailableSeats = trip.availableSeats > 0;

    // Update trip status to ACTIVE and set startedAt
    trip.status = TripStatus.ACTIVE;
    trip.startedAt = new Date();
    await this.tripRepository.save(trip);

    // Invalidate cache
    await this.cacheService.del(CacheService.getTripKey(tripId));
    await this.cacheService.del(CacheService.getTripsListKey());
    await this.cacheService.del(CacheService.getTripsListKey('all'));

    this.logger.log(`Trip ${tripId} started successfully. Available seats: ${trip.availableSeats}, Accepted bookings: ${acceptedBookings.length}`);
    await this.notifyDriverEmergencyContacts(trip, 'trip_started');

    // Notify users based on seat availability
    if (hasAvailableSeats) {
      // Notify all active users (except driver) about available seats
      await this.notifyNearbyUsersAboutTripStart(trip);
    } else {
      // Notify only passengers who have booked
      await this.notifyBookedPassengersAboutTripStart(trip, acceptedBookings);
    }

    return this.findOne(tripId);
  }

  async pauseTrip(tripId: string, driverId: string): Promise<SanitizedTrip> {
    this.logger.log(`Pausing trip ${tripId} by driver ${driverId}`);

    const trip = await this.tripRepository.findOne({
      where: { id: tripId, driverId },
      relations: ['bookings', 'bookings.passenger', 'driver'],
    });

    if (!trip) {
      this.logger.warn(`Trip pause failed: Trip ${tripId} not found for driver ${driverId}`);
      throw new NotFoundException('Trajet non trouve ou vous n\'êtes pas le conducteur');
    }

    if (trip.status !== TripStatus.ACTIVE) {
      this.logger.warn(`Trip pause failed: Trip ${tripId} is not in ACTIVE status (current: ${trip.status})`);
      throw new BadRequestException(`Impossible d'interrompre le trajet. Le trajet doit être en cours (statut actuel : ${trip.status})`);
    }

    // Get accepted bookings
    const acceptedBookings = trip.bookings?.filter(
      (booking) => booking.status === BookingStatus.ACCEPTED,
    ) || [];

    // A driver can interrupt a trip only if passengers have NOT yet been picked up
    const bookingsWithPickedUpPassengers =
      acceptedBookings.filter((booking) => booking.pickedUp || booking.pickedUpConfirmedByPassenger);

    if (bookingsWithPickedUpPassengers.length > 0) {
      this.logger.warn(
        `Trip pause failed: Trip ${tripId} has ${bookingsWithPickedUpPassengers.length} booking(s) with picked up passengers. Driver ${driverId} cannot interrupt an ongoing trip with passengers already picked up.`,
      );
      throw new BadRequestException(
        'Vous ne pouvez pas interrompre un trajet avec des passagers déjà récupérés',
      );
    }

    // Update trip status to PENDING (interrupted) when there are no picked-up passengers
    trip.status = TripStatus.PENDING;
    await this.tripRepository.save(trip);

    // Invalidate cache
    await this.cacheService.del(CacheService.getTripKey(tripId));
    await this.cacheService.del(CacheService.getTripsListKey());
    await this.cacheService.del(CacheService.getTripsListKey('all'));

    this.logger.log(
      `Trip ${tripId} paused successfully. Notifying ${acceptedBookings.length} passengers (not yet picked up).`,
    );

    // Notify booked passengers (with accepted bookings) about trip interruption
    await this.notifyPassengersAboutTripPause(trip, acceptedBookings);

    return this.findOne(tripId);
  }

  private async notifyNearbyUsersAboutTripStart(trip: Trip): Promise<void> {
    try {
      this.logger.log(`Notifying nearby users about trip ${trip.id} start (${trip.availableSeats} seats available)`);

      // Get all active users with FCM tokens (except the driver)
      const users = await this.userRepository.find({
        where: {
          isActive: true,
        },
        select: ['id', 'fcmToken', 'firstName'],
      });

      // Filter out driver and users without FCM tokens
      const usersToNotify = users.filter(
        (user) => user.id !== trip.driverId && user.fcmToken,
      );

      if (usersToNotify.length === 0) {
        this.logger.debug('No users to notify about trip start');
        return;
      }

      const fcmTokens = usersToNotify.map((user) => user.fcmToken!);
      const userIds = usersToNotify.map((user) => user.id);

      const title = '🚗 Trajet disponible maintenant';
      const body = `Un trajet vient de démarrer : ${trip.departureLocation} → ${trip.arrivalLocation} (${trip.availableSeats} place${trip.availableSeats > 1 ? 's' : ''} disponible${trip.availableSeats > 1 ? 's' : ''})`;

      const data = {
        type: 'trip_started',
        tripId: trip.id,
        departureLocation: trip.departureLocation,
        arrivalLocation: trip.arrivalLocation,
        availableSeats: trip.availableSeats.toString(),
        pricePerSeat: trip.pricePerSeat.toString(),
        departureDate: trip.departureDate.toISOString(),
      };

      await this.notificationService.sendToMultiple(fcmTokens, title, body, data, userIds);
      this.logger.log(`Notified ${fcmTokens.length} users about trip ${trip.id} start`);
    } catch (error) {
      this.logger.error(`Error notifying nearby users about trip start: ${error.message}`, error.stack);
    }
  }

  private async notifyBookedPassengersAboutTripStart(
    trip: Trip,
    acceptedBookings: Booking[],
  ): Promise<void> {
    try {
      this.logger.log(`Notifying ${acceptedBookings.length} booked passengers about trip ${trip.id} start`);

      if (acceptedBookings.length === 0) {
        this.logger.debug('No accepted bookings to notify');
        return;
      }

      // Get passengers with FCM tokens
      const passengerIds = acceptedBookings.map((booking) => booking.passengerId);
      const passengers = await this.userRepository.find({
        where: {
          id: In(passengerIds),
        },
        select: ['id', 'fcmToken', 'firstName'],
      });

      const passengersWithTokens = passengers.filter((passenger) => passenger.fcmToken);

      if (passengersWithTokens.length === 0) {
        this.logger.debug('No passengers with FCM tokens to notify');
        return;
      }

      const fcmTokens = passengersWithTokens.map((passenger) => passenger.fcmToken!);
      const userIds = passengersWithTokens.map((passenger) => passenger.id);

      const title = '🚗 Votre trajet a démarré';
      const body = `Le trajet ${trip.departureLocation} → ${trip.arrivalLocation} vient de démarrer. Préparez-vous !`;

      const data = {
        type: 'trip_started',
        tripId: trip.id,
        departureLocation: trip.departureLocation,
        arrivalLocation: trip.arrivalLocation,
        departureDate: trip.departureDate.toISOString(),
      };

      await this.notificationService.sendToMultiple(fcmTokens, title, body, data, userIds);
      this.logger.log(`Notified ${fcmTokens.length} passengers about trip ${trip.id} start`);
    } catch (error) {
      this.logger.error(`Error notifying booked passengers about trip start: ${error.message}`, error.stack);
    }
  }

  private async notifyPassengersAboutTripPause(
    trip: Trip,
    acceptedBookings: Booking[],
  ): Promise<void> {
    try {
      this.logger.log(`Notifying ${acceptedBookings.length} passengers about trip ${trip.id} pause`);

      if (acceptedBookings.length === 0) {
        this.logger.debug('No accepted bookings to notify about pause');
        return;
      }

      // Get passengers with FCM tokens
      const passengerIds = acceptedBookings.map((booking) => booking.passengerId);
      const passengers = await this.userRepository.find({
        where: {
          id: In(passengerIds),
        },
        select: ['id', 'fcmToken', 'firstName'],
      });

      const passengersWithTokens = passengers.filter((passenger) => passenger.fcmToken);

      if (passengersWithTokens.length === 0) {
        this.logger.debug('No passengers with FCM tokens to notify about pause');
        return;
      }

      const fcmTokens = passengersWithTokens.map((passenger) => passenger.fcmToken!);
      const userIds = passengersWithTokens.map((passenger) => passenger.id);

      const title = '⏸️ Trajet interrompu';
      const body = `Le trajet de ${trip.departureLocation} à ${trip.arrivalLocation} a été interrompu par le conducteur. Vous serez notifié lorsque le trajet reprendra.`;

      const data = {
        type: 'trip_paused',
        tripId: trip.id,
        departureLocation: trip.departureLocation,
        arrivalLocation: trip.arrivalLocation,
        departureDate: trip.departureDate.toISOString(),
      };

      if (fcmTokens.length === 1) {
        await this.notificationService.sendNotification(
          fcmTokens[0],
          title,
          body,
          data,
          userIds[0],
        );
      } else {
        await this.notificationService.sendToMultiple(
          fcmTokens,
          title,
          body,
          data,
          userIds,
        );
      }

      this.logger.log(`Notified ${fcmTokens.length} passengers about trip ${trip.id} pause`);
    } catch (error) {
      this.logger.error(`Error notifying passengers about trip pause: ${error.message}`, error.stack);
    }
  }

  @Cron('0 */6 * * *')
  async generateRecurringTrips() {
    this.logger.debug('Running recurring trip generation cron job');

    const templates = await this.recurringTripTemplateRepository.find({
      where: { status: RecurringTripTemplateStatus.ACTIVE },
    });

    for (const template of templates) {
      try {
        await this.generateTripsForTemplate(template);
      } catch (error) {
        this.logger.error(
          `Failed to generate recurring trips for template ${template.id}: ${error.message}`,
          error.stack,
        );
      }
    }
  }

  private async resolvePublishingContext(
    driverId: string,
    vehicleId?: string | null,
    requireVehicle: boolean = false,
  ): Promise<{ user: User; vehicle: Vehicle | null }> {
    const user = await this.userRepository.findOne({ where: { id: driverId } });
    if (!user) {
      this.logger.warn(`Trip publication failed: User not found - ${driverId}`);
      throw new NotFoundException('Utilisateur non trouve');
    }

    let vehicle: Vehicle | null = null;

    if (vehicleId) {
      vehicle = await this.vehicleRepository.findOne({
        where: { id: vehicleId, ownerId: driverId },
      });

      if (!vehicle) {
        this.logger.warn(
          `Trip publication failed: Vehicle ${vehicleId} not found or does not belong to user ${driverId}`,
        );
        throw new BadRequestException('Vehicule non trouve ou ne vous appartient pas');
      }

      if (!vehicle.isActive) {
        this.logger.warn(`Trip publication failed: Vehicle ${vehicleId} is not active`);
        throw new BadRequestException('Le vehicule selectionne n est pas actif');
      }

      if (!this.isDriverRole(user.role)) {
        this.logger.log(`Promoting user ${driverId} to driver for trip publication`);
        user.role = UserRole.DRIVER;
        user.isDriver = true;
        await this.userRepository.save(user);
      }
    } else {
      if (requireVehicle) {
        throw new BadRequestException('Veuillez selectionner un vehicule actif');
      }

      if (!this.isDriverRole(user.role)) {
        this.logger.warn(`Trip publication failed: User ${driverId} is not a driver`);
        throw new BadRequestException(
          'Vous devez etre conducteur ou fournir un vehicule pour creer un trajet',
        );
      }
    }

    return { user, vehicle };
  }

  private isDriverRole(role?: User['role'] | null): boolean {
    return role === UserRole.DRIVER;
  }

  private async findRecurringTemplateEntity(
    templateId: string,
    driverId: string,
  ): Promise<RecurringTripTemplate> {
    const template = await this.recurringTripTemplateRepository.findOne({
      where: { id: templateId, driverId },
      relations: ['vehicle'],
    });

    if (!template) {
      throw new NotFoundException('Trajet recurrent non trouve');
    }

    return template;
  }

  private async findRecurringById(
    templateId: string,
    driverId: string,
  ): Promise<SanitizedRecurringTripTemplate> {
    const template = await this.findRecurringTemplateEntity(templateId, driverId);
    const futureMeta = await this.buildRecurringTripFutureMeta([template]);
    return this.sanitizeRecurringTripTemplate(template, futureMeta.get(template.id));
  }

  private async generateTripsForTemplate(template: RecurringTripTemplate): Promise<number> {
    if (template.status !== RecurringTripTemplateStatus.ACTIVE) {
      return 0;
    }

    const now = new Date();
    const today = this.startOfDay(now);
    const templateStartDate = this.parseDateOnly(template.startDate);
    const lastGeneratedDate = template.lastGeneratedDate
      ? this.parseDateOnly(template.lastGeneratedDate)
      : null;
    const nextGenerationStart = lastGeneratedDate
      ? this.addDays(lastGeneratedDate, 1)
      : templateStartDate;
    const generationStart = nextGenerationStart > today ? nextGenerationStart : today;
    const windowEnd = this.addDays(today, this.RECURRING_GENERATION_WINDOW_DAYS);
    const templateEndDate = template.endDate ? this.parseDateOnly(template.endDate) : null;
    const generationEnd =
      templateEndDate && templateEndDate < windowEnd ? templateEndDate : windowEnd;

    if (generationStart > generationEnd) {
      return 0;
    }

    const fromDate = this.formatDateOnly(generationStart);
    const toDate = this.formatDateOnly(generationEnd);

    const existingTrips = await this.tripRepository.find({
      where: {
        recurringTemplateId: template.id,
        recurringOccurrenceDate: Between(fromDate, toDate),
      },
      select: ['id', 'recurringOccurrenceDate'],
    });

    const existingOccurrences = new Set(
      existingTrips
        .map((trip) => trip.recurringOccurrenceDate)
        .filter((value): value is string => Boolean(value)),
    );

    const tripsToCreate: Trip[] = [];

    for (
      let cursor = new Date(generationStart);
      cursor <= generationEnd;
      cursor = this.addDays(cursor, 1)
    ) {
      const occurrenceDate = this.formatDateOnly(cursor);
      if (!template.weekdays.includes(this.toIsoWeekday(cursor))) {
        continue;
      }

      if (existingOccurrences.has(occurrenceDate)) {
        continue;
      }

      const departureDate = this.combineDateAndTime(cursor, template.departureTimeMinutes);
      if (departureDate <= now) {
        continue;
      }

      tripsToCreate.push(
        this.tripRepository.create({
          driverId: template.driverId,
          vehicleId: template.vehicleId,
          departureLocation: template.departureLocation,
          departurePoint: template.departurePoint,
          arrivalLocation: template.arrivalLocation,
          arrivalPoint: template.arrivalPoint,
          departureDate,
          totalSeats: template.totalSeats,
          availableSeats: template.totalSeats,
          pricePerSeat: template.isFree ? 0 : template.pricePerSeat,
          isFree: template.isFree,
          description: template.description ?? undefined,
          status: TripStatus.PENDING,
          isPrivate: false,
          tripRequestId: null,
          recurringTemplateId: template.id,
          recurringOccurrenceDate: occurrenceDate,
        }),
      );
    }

    if (tripsToCreate.length > 0) {
      await this.tripRepository.save(tripsToCreate);
      await this.invalidateTripCaches();
    }

    template.lastGeneratedDate = toDate;
    await this.recurringTripTemplateRepository.save(template);

    return tripsToCreate.length;
  }

  private async buildRecurringTripFutureMeta(
    templates: RecurringTripTemplate[],
  ): Promise<Map<string, RecurringTripFutureMeta>> {
    const meta = new Map<string, RecurringTripFutureMeta>();

    if (templates.length === 0) {
      return meta;
    }

    templates.forEach((template) => {
      meta.set(template.id, {
        nextOccurrenceDate: null,
        upcomingGeneratedTripsCount: 0,
      });
    });

    const templateIds = templates.map((template) => template.id);
    const futureTrips = await this.tripRepository.find({
      where: {
        recurringTemplateId: In(templateIds),
        departureDate: MoreThan(new Date()),
        status: In([TripStatus.PENDING, TripStatus.ACTIVE]),
      },
      order: {
        departureDate: 'ASC',
      },
    });

    for (const trip of futureTrips) {
      if (!trip.recurringTemplateId) {
        continue;
      }

      const currentMeta = meta.get(trip.recurringTemplateId);
      if (!currentMeta) {
        continue;
      }

      currentMeta.upcomingGeneratedTripsCount += 1;
      if (!currentMeta.nextOccurrenceDate) {
        currentMeta.nextOccurrenceDate = trip.departureDate.toISOString();
      }
    }

    for (const template of templates) {
      const currentMeta = meta.get(template.id);
      if (!currentMeta || currentMeta.nextOccurrenceDate) {
        continue;
      }

      const nextOccurrence = this.computeNextOccurrenceDate(template);
      currentMeta.nextOccurrenceDate = nextOccurrence ? nextOccurrence.toISOString() : null;
    }

    return meta;
  }

  private async sanitizeRecurringTripTemplate(
    template: RecurringTripTemplate,
    futureMeta?: RecurringTripFutureMeta,
  ): Promise<SanitizedRecurringTripTemplate> {
    const { departurePoint, arrivalPoint, departureTimeMinutes, vehicle, ...rest } = template;
    let sanitizedVehicle: SanitizedVehicle | null = null;

    if (vehicle) {
      let photoUrl = vehicle.photoUrl;
      if (photoUrl) {
        photoUrl = await this.fileUploadService.getPresignedUrlIfS3Key(photoUrl) || photoUrl;
      }

      sanitizedVehicle = {
        id: vehicle.id,
        brand: vehicle.brand,
        model: vehicle.model,
        color: vehicle.color,
        licensePlate: vehicle.licensePlate,
        photoUrl,
      };
    }

    return {
      ...rest,
      departureCoordinates: this.pointToCoordinates(departurePoint),
      arrivalCoordinates: this.pointToCoordinates(arrivalPoint),
      departureTime: this.formatMinutesAsTime(departureTimeMinutes),
      vehicle: sanitizedVehicle,
      nextOccurrenceDate: futureMeta?.nextOccurrenceDate ?? null,
      upcomingGeneratedTripsCount: futureMeta?.upcomingGeneratedTripsCount ?? 0,
    };
  }

  private async invalidateTripCaches(tripId?: string): Promise<void> {
    if (tripId) {
      await this.cacheService.del(CacheService.getTripKey(tripId));
    }

    await this.cacheService.del(CacheService.getTripsListKey());
    await this.cacheService.del(CacheService.getTripsListKey('all'));
    await this.cacheService.del(CacheService.getTripsListKey('allTrips'));
  }

  private parseDateOnly(value: string): Date {
    const [year, month, day] = value.split('-').map((item) => Number(item));
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  }

  private formatDateOnly(date: Date): string {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private parseTimeToMinutes(value: string): number {
    const [hours, minutes] = value.split(':').map((item) => Number(item));
    return hours * 60 + minutes;
  }

  private formatMinutesAsTime(value: number): string {
    const hours = `${Math.floor(value / 60)}`.padStart(2, '0');
    const minutes = `${value % 60}`.padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  private normalizeWeekdays(weekdays: number[]): number[] {
    return Array.from(
      new Set(weekdays.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)),
    ).sort((left, right) => left - right);
  }

  private combineDateAndTime(date: Date, departureTimeMinutes: number): Date {
    const next = new Date(date);
    next.setHours(Math.floor(departureTimeMinutes / 60), departureTimeMinutes % 60, 0, 0);
    return next;
  }

  private startOfDay(value: Date): Date {
    const next = new Date(value);
    next.setHours(0, 0, 0, 0);
    return next;
  }

  private addDays(value: Date, amount: number): Date {
    const next = new Date(value);
    next.setDate(next.getDate() + amount);
    return next;
  }

  private toIsoWeekday(date: Date): number {
    const weekday = date.getDay();
    return weekday === 0 ? 7 : weekday;
  }

  private computeNextOccurrenceDate(template: RecurringTripTemplate): Date | null {
    if (template.status !== RecurringTripTemplateStatus.ACTIVE) {
      return null;
    }

    const now = new Date();
    const startDate = this.parseDateOnly(template.startDate);
    const endDate = template.endDate ? this.parseDateOnly(template.endDate) : null;
    const cursor = this.startOfDay(startDate > now ? startDate : now);

    for (let offset = 0; offset <= 365; offset += 1) {
      const currentDate = this.addDays(cursor, offset);

      if (endDate && currentDate > endDate) {
        return null;
      }

      if (!template.weekdays.includes(this.toIsoWeekday(currentDate))) {
        continue;
      }

      const departureDate = this.combineDateAndTime(currentDate, template.departureTimeMinutes);
      if (departureDate > now) {
        return departureDate;
      }
    }

    return null;
  }
  private buildPointFromCoordinates([longitude, latitude]: [number, number]): Point {
    return {
      type: 'Point',
      coordinates: [Number(longitude), Number(latitude)],
    };
  }

  private async sanitizeTrip(
    trip: Trip,
    userRatingsMap?: Map<string, UserRatingSummary>,
  ): Promise<SanitizedTrip> {
    const { driver, bookings, departurePoint, arrivalPoint, vehicle, ...rest } = trip;

    // Convert vehicle photo URL to presigned URL if needed
    let sanitizedVehicle: SanitizedVehicle | null = null;
    if (vehicle) {
      let photoUrl = vehicle.photoUrl;
      if (photoUrl) {
        photoUrl = await this.fileUploadService.getPresignedUrlIfS3Key(photoUrl) || photoUrl;
      }
      sanitizedVehicle = {
        id: vehicle.id,
        brand: vehicle.brand,
        model: vehicle.model,
        color: vehicle.color,
        licensePlate: vehicle.licensePlate,
        photoUrl,
      };
    }

    // Sanitize driver with profile picture (presigned URL if S3 key)
    const sanitizedDriver = await this.sanitizeUser(driver, userRatingsMap);

    // Sanitize bookings with passenger profile pictures (presigned URLs if S3 keys)
    const sanitizedBookings = bookings
      ? await Promise.all(
          bookings.map((booking) => this.sanitizeBooking(booking, userRatingsMap)),
        )
      : [];

    return {
      ...(rest as Omit<Trip, 'driver' | 'bookings' | 'departurePoint' | 'arrivalPoint' | 'vehicle'>),
      departureCoordinates: this.pointToCoordinates(departurePoint),
      arrivalCoordinates: this.pointToCoordinates(arrivalPoint),
      driver: sanitizedDriver,
      bookings: sanitizedBookings,
      vehicle: sanitizedVehicle,
    } as SanitizedTrip;
  }

  private async sanitizeBooking(
    booking: Booking,
    userRatingsMap?: Map<string, UserRatingSummary>,
  ): Promise<SanitizedBooking> {
    const { passenger, trip, messages, ...rest } = booking;
    return {
      ...(rest as Omit<Booking, 'trip' | 'passenger' | 'messages'>),
      passenger: await this.sanitizeUser(passenger, userRatingsMap),
    } as SanitizedBooking;
  }

  private async sanitizeUser(
    user?: User,
    userRatingsMap?: Map<string, UserRatingSummary>,
  ): Promise<SanitizedUser | null> {
    if (!user) {
      return null;
    }

    // Convert S3 key to presigned URL for profile picture
    let profilePicture: string | null = null;
    if (user.profilePicture) {
      profilePicture = await this.fileUploadService.getPresignedUrlIfS3Key(user.profilePicture);
      // If getPresignedUrlIfS3Key returns null, it means it's not an S3 key, so use the original value
      if (!profilePicture) {
        profilePicture = user.profilePicture;
      }
    }

    const userRatingSummary = userRatingsMap
      ? userRatingsMap.get(user.id) ?? { averageRating: null, totalRatings: 0 }
      : await this.getUserRatingSummary(user.id);

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      profilePicture,
      role: user.role,
      status: user.status,
      isDriver: user.isDriver,
      averageRating: userRatingSummary.averageRating,
      totalRatings: userRatingSummary.totalRatings,
    };
  }

  private collectTripUserIds(trips: Trip[]): string[] {
    const userIds = new Set<string>();

    for (const trip of trips) {
      if (trip.driverId) {
        userIds.add(trip.driverId);
      }

      if (trip.bookings?.length) {
        for (const booking of trip.bookings) {
          if (booking.passengerId) {
            userIds.add(booking.passengerId);
          }
        }
      }
    }

    return [...userIds];
  }

  private async buildUserRatingsMap(
    userIds: string[],
  ): Promise<Map<string, UserRatingSummary>> {
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
    const ratingsMap = new Map<string, UserRatingSummary>();

    for (const userId of uniqueUserIds) {
      ratingsMap.set(userId, {
        averageRating: null,
        totalRatings: 0,
      });
    }

    if (uniqueUserIds.length === 0) {
      return ratingsMap;
    }

    const stats = await this.ratingRepository
      .createQueryBuilder('rating')
      .select('rating.ratedUserId', 'ratedUserId')
      .addSelect('AVG(rating.rating)', 'averageRating')
      .addSelect('COUNT(rating.id)', 'totalRatings')
      .where('rating.ratedUserId IN (:...userIds)', { userIds: uniqueUserIds })
      .groupBy('rating.ratedUserId')
      .getRawMany<{
        ratedUserId: string;
        averageRating: string | null;
        totalRatings: string;
      }>();

    for (const row of stats) {
      ratingsMap.set(row.ratedUserId, {
        averageRating: row.averageRating
          ? Math.round(parseFloat(row.averageRating) * 10) / 10
          : null,
        totalRatings: row.totalRatings ? parseInt(row.totalRatings, 10) : 0,
      });
    }

    return ratingsMap;
  }

  private async getUserRatingSummary(userId: string): Promise<UserRatingSummary> {
    const stats = await this.ratingRepository
      .createQueryBuilder('rating')
      .select('AVG(rating.rating)', 'averageRating')
      .addSelect('COUNT(rating.id)', 'totalRatings')
      .where('rating.ratedUserId = :userId', { userId })
      .getRawOne<{ averageRating: string | null; totalRatings: string }>();

    return {
      averageRating: stats?.averageRating
        ? Math.round(parseFloat(stats.averageRating) * 10) / 10
        : null,
      totalRatings: stats?.totalRatings ? parseInt(stats.totalRatings, 10) : 0,
    };
  }

  private pointToCoordinates(point?: Point): Coordinates {
    if (!point?.coordinates) {
      return null;
    }

    const [longitude, latitude] = point.coordinates;
    return [Number(longitude), Number(latitude)];
  }

  private async verifyTripParticipant(tripId: string, userId: string) {
    const trip = await this.tripRepository.findOne({
      where: { id: tripId },
      relations: ['bookings'],
    });

    if (!trip) {
      throw new NotFoundException('Trajet non trouve');
    }

    const isDriver = trip.driverId === userId;
    const isPassenger =
      trip.bookings?.some(
        (booking) =>
          booking.passengerId === userId &&
          booking.status === BookingStatus.ACCEPTED,
      ) ?? false;

    if (!isDriver && !isPassenger) {
      throw new ForbiddenException('Vous ne faites pas partie de ce trajet');
    }

    return { trip, isDriver, isPassenger };
  }

  async ensureUserCanTrackTrip(tripId: string, userId: string) {
    const { trip } = await this.verifyTripParticipant(tripId, userId);

    // Real-time tracking is only allowed for ACTIVE trips
    if (trip.status !== TripStatus.ACTIVE) {
      this.logger.warn(
        `Tracking not allowed for trip ${tripId} with status ${trip.status} (user: ${userId})`,
      );
      throw new BadRequestException(
        'Le suivi en temps réel est uniquement disponible pour les trajets en cours',
      );
    }
  }

  async updateDriverLocation(
    driverId: string,
    tripId: string,
    coordinates: [number, number],
  ) {
    const { trip, isDriver } = await this.verifyTripParticipant(
      tripId,
      driverId,
    );

    if (!isDriver) {
      throw new ForbiddenException('Seul le conducteur peut mettre à jour la localisation');
    }

    // Stop tracking updates if trip is not ACTIVE
    if (trip.status !== TripStatus.ACTIVE) {
      this.logger.warn(
        `Ignoring location update for trip ${tripId} with status ${trip.status} (driver: ${driverId})`,
      );
      throw new BadRequestException(
        'Le trajet n’est plus en cours, le suivi en temps réel est arrêté',
      );
    }

    trip.currentLocation = this.buildPointFromCoordinates(coordinates);
    trip.lastLocationUpdateAt = new Date();

    await this.tripRepository.save(trip);

    return {
      tripId: trip.id,
      coordinates,
      updatedAt: trip.lastLocationUpdateAt,
    };
  }

  async getDriverLocationForUser(tripId: string, userId: string) {
    const { trip } = await this.verifyTripParticipant(tripId, userId);

    // If trip is no longer ACTIVE, stop real-time tracking and prevent further polling
    if (trip.status !== TripStatus.ACTIVE) {
      this.logger.warn(
        `Driver location requested for non-active trip ${tripId} (status: ${trip.status}, user: ${userId})`,
      );
      throw new BadRequestException(
        'Le trajet n’est plus en cours, le suivi en temps réel est arrêté',
      );
    }
    return {
      tripId: trip.id,
      coordinates: this.pointToCoordinates(trip.currentLocation),
      updatedAt: trip.lastLocationUpdateAt,
    };
  }

  /**
   * Cron job to mark expired trips and their bookings as expired
   * - PENDING trips expire 2 hours after scheduled departure
   * - ACTIVE trips expire only after 12 hours without interaction since trip start
   * Runs every hour.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async markExpiredTrips() {
    // Use setImmediate to ensure HTTP requests have priority
    setImmediate(async () => {
      this.logger.debug('Running cron job to mark expired trips');

    const now = new Date();
    // Calculate thresholds
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);

    // 1) PENDING trips that should expire 2 hours after departure
    //    Only trips that have NEVER been started (startedAt IS NULL)
    const pendingTripsToExpire = await this.tripRepository.find({
      where: {
        status: TripStatus.PENDING,
        startedAt: IsNull(),
        departureDate: LessThan(twoHoursAgo),
      },
      relations: ['driver', 'bookings', 'bookings.passenger', 'vehicle'],
    });

    // 2) ACTIVE trips that have been started for at least 12h
    const activeTripsCandidates = await this.tripRepository.find({
      where: {
        status: TripStatus.ACTIVE,
        startedAt: LessThan(twelveHoursAgo),
      },
      relations: ['driver', 'bookings', 'bookings.passenger', 'vehicle'],
    });

    // Expire only if there has been no interaction for 12h after start.
    // We rely on trip.updatedAt, which is refreshed on trip/booking interactions.
    const activeTripsToExpire = activeTripsCandidates.filter((trip) => {
      const lastInteractionAt = trip.updatedAt ?? trip.startedAt ?? trip.departureDate;
      return lastInteractionAt < twelveHoursAgo;
    });

    const tripsToExpire = [...pendingTripsToExpire, ...activeTripsToExpire];

    if (tripsToExpire.length === 0) {
      this.logger.debug('No expired trips found');
      return;
    }

    this.logger.log(
      `Found ${tripsToExpire.length} trips to auto-complete as expired ` +
        `(pending: ${pendingTripsToExpire.length}, active_inactive_12h: ${activeTripsToExpire.length})`,
    );

    for (const trip of tripsToExpire) {
      // Mark trip as completed
      await this.tripRepository.update(trip.id, {
        status: TripStatus.COMPLETED,
        completedAt: now,
      });

      // Mark all pending and accepted bookings as expired
      const bookingsToExpire = trip.bookings?.filter(
        (booking) =>
          booking.status === BookingStatus.PENDING ||
          booking.status === BookingStatus.ACCEPTED,
      ) || [];

      const bookingsMissingDropoff = bookingsToExpire.filter(
        (booking) =>
          (booking.pickedUp || booking.pickedUpConfirmedByPassenger) &&
          !booking.droppedOff &&
          !booking.droppedOffConfirmedByPassenger,
      );

      if (bookingsToExpire.length > 0) {
        const bookingIds = bookingsToExpire.map((b) => b.id);
        await this.bookingRepository.update(
          { id: In(bookingIds) },
          { status: BookingStatus.EXPIRED },
        );
        this.logger.log(
          `Marked ${bookingsToExpire.length} bookings as expired for trip ${trip.id}`,
        );
      }

      // Restore available seats for expired bookings
      const totalSeatsToRestore = bookingsToExpire.reduce(
        (sum, booking) => sum + booking.numberOfSeats,
        0,
      );

      if (totalSeatsToRestore > 0) {
        await this.tripRepository.increment(
          { id: trip.id },
          'availableSeats',
          totalSeatsToRestore,
        );
        this.logger.log(
          `Restored ${totalSeatsToRestore} seats for trip ${trip.id}`,
        );
      }

      // Notify driver about trip expiration
      await this.notifyDriverAboutTripExpiration(trip);

      // Notify passengers about trip expiration
      await this.notifyPassengersAboutTripExpiration(trip, bookingsToExpire);

      // Notify selected emergency contacts when a picked-up passenger has no dropoff confirmation.
      await this.notifyEmergencyContactsForMissingDropoff(trip, bookingsMissingDropoff);

      // Invalidate cache for this trip
      await this.cacheService.del(CacheService.getTripKey(trip.id));
    }

    // Invalidate trips list cache
    await this.cacheService.del(CacheService.getTripsListKey());
    await this.cacheService.del(CacheService.getTripsListKey('all'));

    this.logger.log(
      `Successfully marked ${tripsToExpire.length} trips and their bookings as expired`,
    );
    });
  }

  /**
   * Cron job to notify drivers and passengers about upcoming trip departure
   * Runs every 15 minutes to check for trips starting in the next 30 minutes
   */
  @Cron('*/15 * * * *') // Every 15 minutes
  async notifyAboutUpcomingTripDeparture() {
    // Use setImmediate to ensure HTTP requests have priority
    setImmediate(async () => {
      this.logger.debug('Running cron job to notify about upcoming trip departure');

    const now = new Date();
    const thirtyMinutesFromNow = new Date(now.getTime() + 30 * 60 * 1000); // 30 minutes from now

    // Find all pending trips starting in the next 30 minutes that haven't been notified yet
    const tripsStartingSoon = await this.tripRepository.find({
      where: {
        status: TripStatus.PENDING,
        departureReminderNotified: false,
        departureDate: Between(now, thirtyMinutesFromNow),
      },
      relations: ['driver', 'bookings', 'bookings.passenger'],
    });

    if (tripsStartingSoon.length === 0) {
      this.logger.debug('No trips starting soon found');
      return;
    }

    this.logger.log(`Found ${tripsStartingSoon.length} trips starting soon`);

    for (const trip of tripsStartingSoon) {
      // Notify driver and passengers
      await this.notifyAboutTripDeparture(trip);

      // Mark as notified
      trip.departureReminderNotified = true;
      await this.tripRepository.save(trip);
    }

    this.logger.log(
      `Successfully notified about ${tripsStartingSoon.length} trips starting soon`,
    );
    });
  }

  /**
   * Notify driver and passengers about upcoming trip departure
   */
  private async notifyAboutTripDeparture(trip: Trip): Promise<void> {
    try {
      // Notify driver
      if (trip.driver?.fcmToken) {
        const minutesUntilDeparture = Math.round(
          (trip.departureDate.getTime() - new Date().getTime()) / (60 * 1000),
        );

        const title = '⏰ Départ du trajet proche';
        const body = `Votre trajet de ${trip.departureLocation} à ${trip.arrivalLocation} commence dans ${minutesUntilDeparture} minute${minutesUntilDeparture > 1 ? 's' : ''}.`;

        const data = {
          type: 'trip_departure_reminder',
          tripId: trip.id,
          departureLocation: trip.departureLocation,
          driverId: trip.driver.id,
          arrivalLocation: trip.arrivalLocation,
          departureDate: trip.departureDate.toISOString(),
          minutesUntilDeparture,
        };

        await this.notificationService.sendNotification(
          trip.driver.fcmToken,
          title,
          body,
          data,
          trip.driverId,
        );
        this.logger.log(`Notified driver ${trip.driverId} about trip ${trip.id} departure`);
      }

      // Notify passengers with accepted bookings
      const acceptedBookings = trip.bookings?.filter(
        (booking) => booking.status === BookingStatus.ACCEPTED,
      ) || [];

      if (acceptedBookings.length === 0) {
        this.logger.debug(`No accepted bookings to notify for trip ${trip.id}`);
        return;
      }

      const passengerIds = acceptedBookings.map((booking) => booking.passengerId);
      const passengers = await this.userRepository.find({
        where: {
          id: In(passengerIds),
        },
        select: ['id', 'fcmToken', 'firstName', 'lastName'],
      });

      const passengersWithTokens = passengers.filter((passenger) => passenger.fcmToken);

      if (passengersWithTokens.length === 0) {
        this.logger.debug('No passengers with FCM tokens found, skipping notifications');
        return;
      }

      const minutesUntilDeparture = Math.round(
        (trip.departureDate.getTime() - new Date().getTime()) / (60 * 1000),
      );

      const fcmTokens = passengersWithTokens.map((p) => p.fcmToken!);
      const userIds = passengersWithTokens.map((p) => p.id);

      const title = '⏰ Départ du trajet proche';
      const body = `Le trajet de ${trip.departureLocation} à ${trip.arrivalLocation} commence dans ${minutesUntilDeparture} minute${minutesUntilDeparture > 1 ? 's' : ''}. Préparez-vous !`;

      const data = {
        type: 'trip_departure_reminder',
        tripId: trip.id,
        departureLocation: trip.departureLocation,
        arrivalLocation: trip.arrivalLocation,
        departureDate: trip.departureDate.toISOString(),
        minutesUntilDeparture,
      };

      await this.notificationService.sendToMultiple(fcmTokens, title, body, data, userIds);
      this.logger.log(`Notified ${fcmTokens.length} passengers about trip ${trip.id} departure`);
    } catch (error) {
      this.logger.error(
        `Error notifying about trip departure ${trip.id}: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Cron job to notify drivers and passengers about upcoming trip expiration
   * Runs every 15 minutes to check for trips expiring in the next hour
   */
  @Cron('*/15 * * * *') // Every 15 minutes
  async notifyAboutUpcomingTripExpiration() {
    // Use setImmediate to ensure HTTP requests have priority
    setImmediate(async () => {
      this.logger.debug('Running cron job to notify about upcoming trip expiration');

    const now = new Date();
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour from now

    // Find all pending trips expiring in the next hour
    const tripsExpiringSoon = await this.tripRepository.find({
      where: {
        status: TripStatus.PENDING,
        departureDate: Between(now, oneHourFromNow),
      },
      relations: ['driver', 'bookings', 'bookings.passenger'],
    });

    if (tripsExpiringSoon.length === 0) {
      this.logger.debug('No trips expiring soon found');
      return;
    }

    this.logger.log(`Found ${tripsExpiringSoon.length} trips expiring soon`);

    for (const trip of tripsExpiringSoon) {
      // Notify driver about upcoming expiration
      await this.notifyDriverAboutUpcomingExpiration(trip);

      // Notify passengers with accepted bookings
      const acceptedBookings = trip.bookings?.filter(
        (booking) => booking.status === BookingStatus.ACCEPTED,
      ) || [];

      if (acceptedBookings.length > 0) {
        await this.notifyPassengersAboutUpcomingExpiration(trip, acceptedBookings);
      }
    }

    this.logger.log(
      `Successfully notified about ${tripsExpiringSoon.length} trips expiring soon`,
    );
    });
  }

  /**
   * Notify driver about trip expiration
   */
  private async notifyDriverAboutTripExpiration(trip: Trip): Promise<void> {
    try {
      if (!trip.driver?.fcmToken) {
        this.logger.debug(`Driver ${trip.driverId} has no FCM token, skipping notification`);
        return;
      }

      const title = 'Trajet expiré';
      const body = `Votre trajet de ${trip.departureLocation} à ${trip.arrivalLocation} a expiré.`;

      const data = {
        type: 'trip_expired',
        tripId: trip.id,
        driverId: trip.driver.id,
        role: 'driver',
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

      this.logger.log(`Notified driver ${trip.driverId} about expired trip ${trip.id}`);
    } catch (error) {
      this.logger.error(
        `Error notifying driver about trip expiration: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Notify passengers about trip expiration
   */
  private async notifyPassengersAboutTripExpiration(
    trip: Trip,
    bookings: Booking[],
  ): Promise<void> {
    try {
      const passengersWithTokens = bookings
        .filter((booking) => booking.passenger?.fcmToken)
        .map((booking) => ({
          id: booking.passengerId,
          fcmToken: booking.passenger!.fcmToken!,
        }));

      if (passengersWithTokens.length === 0) {
        this.logger.debug('No passengers with FCM tokens found, skipping notifications');
        return;
      }

      const fcmTokens = passengersWithTokens.map((p) => p.fcmToken);
      const passengerIds = passengersWithTokens.map((p) => p.id);

      const title = 'Trajet expiré';
      const body = `Le trajet de ${trip.departureLocation} à ${trip.arrivalLocation} auquel vous aviez réservé a expiré.`;

      const data = {
        type: 'trip_expired',
        tripId: trip.id,
        bookingId: bookings[0]?.id || null,
        departureLocation: trip.departureLocation,
        arrivalLocation: trip.arrivalLocation,
      };

      if (fcmTokens.length === 1) {
        await this.notificationService.sendNotification(
          fcmTokens[0],
          title,
          body,
          data,
          passengerIds[0],
        );
      } else {
        await this.notificationService.sendToMultiple(
          fcmTokens,
          title,
          body,
          data,
          passengerIds,
        );
      }

      this.logger.log(
        `Notified ${fcmTokens.length} passengers about expired trip ${trip.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Error notifying passengers about trip expiration: ${error.message}`,
        error.stack,
      );
    }
  }

  private async notifyDriverEmergencyContacts(
    trip: Trip,
    eventType: 'trip_started' | 'trip_completed',
  ): Promise<void> {
    try {
      const selectedContactIds = trip.driverSafetyEmergencyContactIds ?? [];
      if (selectedContactIds.length === 0) {
        return;
      }

      const contacts = await this.emergencyContactRepository.find({
        where: {
          userId: trip.driverId,
          isActive: true,
          id: In(selectedContactIds),
        },
      });

      if (contacts.length === 0) {
        return;
      }

      this.logger.log(
        `[WA][DriverEmergencyContact][${eventType}] trip=${trip.id} driver=${trip.driverId} selected=${contacts.length}`,
      );

      const driverName = trip.driver
        ? `${trip.driver.firstName} ${trip.driver.lastName}`.trim()
        : 'Le conducteur';
      const vehicleDetails = this.buildVehicleSafetyLabel(trip);
      const passengerNames = this.getConfirmedPassengerNames(trip.bookings ?? []);
      const passengersLabel =
        passengerNames.length > 0 ? passengerNames.join(', ') : 'aucun passager confirme';
      const message =
        eventType === 'trip_started'
          ? [
              'ZWANGA - Mise a jour securite conducteur',
              `${driverName} vient de demarrer son trajet.`,
              `Depart: ${trip.departureLocation}.`,
              `Arrivee: ${trip.arrivalLocation}.`,
              `Conducteur: ${driverName}.`,
              `Vehicule: ${vehicleDetails}.`,
              `Passagers: ${passengersLabel}.`,
            ].join('\n')
          : [
              'ZWANGA - Mise a jour securite conducteur',
              `${driverName} a termine son trajet.`,
              `Depart: ${trip.departureLocation}.`,
              `Arrivee: ${trip.arrivalLocation}.`,
              `Conducteur: ${driverName}.`,
              `Vehicule: ${vehicleDetails}.`,
              `Passagers: ${passengersLabel}.`,
            ].join('\n');

      let sent = 0;
      let failed = 0;

      for (const contact of contacts) {
        this.logger.debug(
          `[WA][DriverEmergencyContact][${eventType}] trip=${trip.id} contactId=${contact.id} phone=${contact.phone} sending...`,
        );
        const whatsappSent = await this.messagingService.sendMessage(contact.phone, message, {
          flow: 'trip_driver_safety',
          eventType,
          tripId: trip.id,
          driverId: trip.driverId,
          contactId: contact.id,
        });
        if (whatsappSent) {
          sent += 1;
          this.logger.log(
            `[WA][DriverEmergencyContact][${eventType}] trip=${trip.id} contactId=${contact.id} status=sent`,
          );
        } else {
          failed += 1;
          this.logger.warn(
            `[WA][DriverEmergencyContact][${eventType}] trip=${trip.id} contactId=${contact.id} status=failed`,
          );
        }
      }

      this.logger.log(
        `[DriverEmergencyContact][${eventType}] trip ${trip.id}: ${sent} sent, ${failed} failed`,
      );
    } catch (error) {
      this.logger.error(
        `Error notifying driver emergency contacts for trip ${trip.id}: ${error.message}`,
        error.stack,
      );
    }
  }

  private async notifyEmergencyContactsForMissingDropoff(
    trip: Trip,
    bookings: Booking[],
  ): Promise<void> {
    try {
      if (bookings.length === 0) {
        return;
      }

      let sent = 0;
      let failed = 0;

      for (const booking of bookings) {
        const selectedContactIds = booking.safetyEmergencyContactIds ?? [];
        if (selectedContactIds.length === 0) {
          continue;
        }

        const contacts = await this.emergencyContactRepository.find({
          where: {
            userId: booking.passengerId,
            isActive: true,
            id: In(selectedContactIds),
          },
        });

        if (contacts.length === 0) {
          continue;
        }

        this.logger.log(
          `[WA][EmergencyContact][trip_end_without_dropoff] trip=${trip.id} booking=${booking.id} selected=${contacts.length}`,
        );

        const passengerName = booking.passenger
          ? `${booking.passenger.firstName} ${booking.passenger.lastName}`.trim()
          : 'Le passager';
        const driverName = trip.driver
          ? `${trip.driver.firstName} ${trip.driver.lastName}`.trim()
          : 'Le conducteur';
        const driverPhone = trip.driver?.phone;
        const vehicleDetails = this.buildVehicleSafetyLabel(trip);
        const otherPassengers = this.getOtherConfirmedPassengerNames(
          trip.bookings ?? [],
          booking.passengerId,
        );
        const otherPassengersLabel =
          otherPassengers.length > 0
            ? otherPassengers.join(', ')
            : 'aucun autre passager confirme';

        const message = [
          'ZWANGA - Alerte securite',
          `Le trajet est termine mais la depose de ${passengerName} n'a pas ete confirmee.`,
          `Depart: ${trip.departureLocation}.`,
          `Arrivee: ${booking.passengerDestination || trip.arrivalLocation}.`,
          `Conducteur: ${driverPhone ? `${driverName} (${driverPhone})` : driverName}.`,
          `Vehicule: ${vehicleDetails}.`,
          `Autres passagers: ${otherPassengersLabel}.`,
        ].join('\n');

        for (const contact of contacts) {
          this.logger.debug(
            `[WA][EmergencyContact][trip_end_without_dropoff] trip=${trip.id} booking=${booking.id} contactId=${contact.id} phone=${contact.phone} sending...`,
          );
          const whatsappSent = await this.messagingService.sendMessage(contact.phone, message, {
            flow: 'trip_passenger_safety',
            eventType: 'trip_end_without_dropoff',
            tripId: trip.id,
            bookingId: booking.id,
            passengerId: booking.passengerId,
            contactId: contact.id,
          });
          if (whatsappSent) {
            sent += 1;
            this.logger.log(
              `[WA][EmergencyContact][trip_end_without_dropoff] trip=${trip.id} booking=${booking.id} contactId=${contact.id} status=sent`,
            );
          } else {
            failed += 1;
            this.logger.warn(
              `[WA][EmergencyContact][trip_end_without_dropoff] trip=${trip.id} booking=${booking.id} contactId=${contact.id} status=failed`,
            );
          }
        }
      }

      if (sent > 0 || failed > 0) {
        this.logger.log(
          `[EmergencyContact][trip_end_without_dropoff] trip ${trip.id}: ${sent} sent, ${failed} failed`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error notifying emergency contacts for missing dropoff on trip ${trip.id}: ${error.message}`,
        error.stack,
      );
    }
  }

  private buildVehicleSafetyLabel(trip: Trip): string {
    if (!trip.vehicle) {
      return 'vehicule non renseigne';
    }
    const brandModel = [trip.vehicle.brand, trip.vehicle.model].filter(Boolean).join(' ');
    const color = trip.vehicle.color ? `, couleur ${trip.vehicle.color}` : '';
    const plate = trip.vehicle.licensePlate ? `, plaque ${trip.vehicle.licensePlate}` : '';
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

      const name = `${booking.passenger.firstName ?? ''} ${booking.passenger.lastName ?? ''}`.trim();
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      names.push(name);
    }

    return names;
  }

  private getOtherConfirmedPassengerNames(bookings: Booking[], currentPassengerId: string): string[] {
    return this.getConfirmedPassengerNames(
      bookings.filter((booking) => booking.passengerId !== currentPassengerId),
    );
  }

  /**
   * Notify driver about upcoming trip expiration
   */
  private async notifyDriverAboutUpcomingExpiration(trip: Trip): Promise<void> {
    try {
      if (!trip.driver?.fcmToken) {
        this.logger.debug(`Driver ${trip.driverId} has no FCM token, skipping notification`);
        return;
      }

      const timeUntilDeparture = Math.round(
        (trip.departureDate.getTime() - new Date().getTime()) / (1000 * 60),
      ); // minutes

      const title = 'Trajet expirant bientôt';
      const body = `Votre trajet de ${trip.departureLocation} à ${trip.arrivalLocation} part dans ${timeUntilDeparture} minute(s).`;

      const data = {
        type: 'trip_expiring_soon',
        tripId: trip.id,
        driverId: trip.driver.id,
        role: 'driver',
        departureLocation: trip.departureLocation,
        arrivalLocation: trip.arrivalLocation,
        departureDate: trip.departureDate.toISOString(),
      };

      await this.notificationService.sendNotification(
        trip.driver.fcmToken,
        title,
        body,
        data,
        trip.driverId,
      );

      this.logger.log(
        `Notified driver ${trip.driverId} about upcoming expiration for trip ${trip.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Error notifying driver about upcoming expiration: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Notify passengers about upcoming trip expiration
   */
  private async notifyPassengersAboutUpcomingExpiration(
    trip: Trip,
    bookings: Booking[],
  ): Promise<void> {
    try {
      const passengersWithTokens = bookings
        .filter((booking) => booking.passenger?.fcmToken)
        .map((booking) => ({
          id: booking.passengerId,
          fcmToken: booking.passenger!.fcmToken!,
        }));

      if (passengersWithTokens.length === 0) {
        this.logger.debug('No passengers with FCM tokens found, skipping notifications');
        return;
      }

      const fcmTokens = passengersWithTokens.map((p) => p.fcmToken);
      const passengerIds = passengersWithTokens.map((p) => p.id);

      const timeUntilDeparture = Math.round(
        (trip.departureDate.getTime() - new Date().getTime()) / (1000 * 60),
      ); // minutes

      const title = 'Trajet expirant bientôt';
      const body = `Le trajet de ${trip.departureLocation} à ${trip.arrivalLocation} auquel vous avez réservé part dans ${timeUntilDeparture} minute(s).`;

      const data = {
        type: 'trip_expiring_soon',
        tripId: trip.id,
        bookingId: bookings[0]?.id || null,
        departureLocation: trip.departureLocation,
        arrivalLocation: trip.arrivalLocation,
        departureDate: trip.departureDate.toISOString(),
      };

      if (fcmTokens.length === 1) {
        await this.notificationService.sendNotification(
          fcmTokens[0],
          title,
          body,
          data,
          passengerIds[0],
        );
      } else {
        await this.notificationService.sendToMultiple(
          fcmTokens,
          title,
          body,
          data,
          passengerIds,
        );
      }

      this.logger.log(
        `Notified ${fcmTokens.length} passengers about upcoming expiration for trip ${trip.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Error notifying passengers about upcoming expiration: ${error.message}`,
        error.stack,
      );
    }
  }
}




