import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Point } from 'typeorm';
import { Trip, TripStatus } from './entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { CreateTripDto, SearchTripsDto, UpdateTripDto } from './dto/trip.dto';
import { CacheService } from '../common/services/cache.service';
import { FileUploadService } from '../common/services/file-upload.service';

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
}

export type SanitizedBooking = Omit<Booking, 'trip' | 'passenger' | 'messages'> & {
  passenger: SanitizedUser | null;
};

export type SanitizedTrip = Omit<Trip, 'driver' | 'bookings' | 'departurePoint' | 'arrivalPoint'> & {
  driver: SanitizedUser | null;
  bookings: SanitizedBooking[];
  departureCoordinates: Coordinates;
  arrivalCoordinates: Coordinates;
};

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);
  private readonly CACHE_TTL = 300; // 5 minutes

  constructor(
    @InjectRepository(Trip)
    private tripRepository: Repository<Trip>,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private cacheService: CacheService,
    private fileUploadService: FileUploadService,
  ) {}

  async create(driverId: string, createTripDto: CreateTripDto): Promise<SanitizedTrip> {
    this.logger.log(`Creating trip for driver: ${driverId} from ${createTripDto.departureLocation} to ${createTripDto.arrivalLocation}`);
    
    const driver = await this.userRepository.findOne({ where: { id: driverId } });
    if (!driver) {
      this.logger.warn(`Trip creation failed: Driver not found - ${driverId}`);
      throw new NotFoundException('Driver not found');
    }

    if (driver.role !== 'driver') {
      this.logger.warn(`Trip creation failed: User ${driverId} is not a driver`);
      throw new BadRequestException('User must be a driver to create trips');
    }

    const {
      departureCoordinates,
      arrivalCoordinates,
      departureDate,
      ...baseTripData
    } = createTripDto;

    const trip = this.tripRepository.create({
      ...baseTripData,
      driverId,
      departureDate: new Date(departureDate),
      departurePoint: this.buildPointFromCoordinates(departureCoordinates),
      arrivalPoint: this.buildPointFromCoordinates(arrivalCoordinates),
    });

    const savedTrip = await this.tripRepository.save(trip);
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getTripsListKey());
    await this.cacheService.del(CacheService.getTripsListKey('all'));

    this.logger.log(`Trip created successfully: ${savedTrip.id} by driver ${driverId}`);
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

    const trips = await this.tripRepository.find({
      relations: ['driver', 'bookings', 'bookings.passenger'],
      where: { status: TripStatus.PENDING },
      order: { departureDate: 'ASC' },
    });

    const sanitized = await Promise.all(trips.map((trip) => this.sanitizeTrip(trip)));

    await this.cacheService.set(cacheKey, sanitized, this.CACHE_TTL);
    this.logger.log(`Fetched ${trips.length} trips from database`);
    return sanitized;
  }

  async search(searchTripsDto: SearchTripsDto): Promise<SanitizedTrip[]> {
    this.logger.log(`Searching trips with filters: ${JSON.stringify(searchTripsDto)}`);
    
    const queryBuilder = this.tripRepository
      .createQueryBuilder('trip')
      .leftJoinAndSelect('trip.driver', 'driver')
      .leftJoinAndSelect('trip.bookings', 'bookings')
      .leftJoinAndSelect('bookings.passenger', 'bookingPassenger')
      .where('trip.status = :status', { status: TripStatus.PENDING });

    if (searchTripsDto.departureDate) {
      const date = new Date(searchTripsDto.departureDate);
      const startOfDay = new Date(date.setHours(0, 0, 0, 0));
      const endOfDay = new Date(date.setHours(23, 59, 59, 999));
      queryBuilder.andWhere('trip.departureDate BETWEEN :start AND :end', {
        start: startOfDay,
        end: endOfDay,
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

    if (searchTripsDto.maxPrice) {
      queryBuilder.andWhere('trip.pricePerSeat <= :maxPrice', {
        maxPrice: searchTripsDto.maxPrice,
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
    const sanitized = await Promise.all(results.map((trip) => this.sanitizeTrip(trip)));
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
      relations: ['driver', 'driver.vehicles', 'bookings', 'bookings.passenger'],
    });

    if (!trip) {
      this.logger.warn(`Trip not found: ${id}`);
      throw new NotFoundException('Trip not found');
    }

    const sanitized = await this.sanitizeTrip(trip);
    await this.cacheService.set(cacheKey, sanitized, this.CACHE_TTL);
    this.logger.debug(`Trip ${id} fetched from database`);
    return sanitized;
  }

  async findByDriver(driverId: string): Promise<SanitizedTrip[]> {
    this.logger.debug(`Fetching trips for driver: ${driverId}`);
    
    const trips = await this.tripRepository.find({
      where: { driverId },
      relations: ['bookings', 'bookings.passenger', 'driver'],
      order: { departureDate: 'DESC' },
    });

    const sanitized = trips.map((trip) => this.sanitizeTrip(trip));

    this.logger.debug(`Found ${trips.length} trips for driver ${driverId}`);
    const sanitizedResults = await Promise.all(sanitized);
    return sanitizedResults;
  }

  async update(id: string, driverId: string, updateTripDto: UpdateTripDto): Promise<SanitizedTrip> {
    this.logger.log(`Updating trip ${id} by driver ${driverId}`);
    
    const trip = await this.tripRepository.findOne({
      where: { id, driverId },
    });

    if (!trip) {
      this.logger.warn(`Trip update failed: Trip ${id} not found for driver ${driverId}`);
      throw new NotFoundException('Trip not found');
    }

    const {
      departureDate,
      departureCoordinates,
      arrivalCoordinates,
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

    Object.assign(trip, restPayload);
    const updatedTrip = await this.tripRepository.save(trip);
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getTripKey(id));
    await this.cacheService.del(CacheService.getTripsListKey());
    await this.cacheService.del(CacheService.getTripsListKey('all'));

    this.logger.log(`Trip ${id} updated successfully`);
    return this.findOne(id);
  }

  async remove(id: string, driverId: string): Promise<void> {
    this.logger.log(`Cancelling trip ${id} by driver ${driverId}`);
    
    const trip = await this.tripRepository.findOne({
      where: { id, driverId },
    });

    if (!trip) {
      this.logger.warn(`Trip cancellation failed: Trip ${id} not found for driver ${driverId}`);
      throw new NotFoundException('Trip not found');
    }

    await this.tripRepository.remove(trip);
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getTripKey(id));
    await this.cacheService.del(CacheService.getTripsListKey());
    await this.cacheService.del(CacheService.getTripsListKey('all'));

    this.logger.log(`Trip ${id} cancelled successfully`);
  }
  private buildPointFromCoordinates([longitude, latitude]: [number, number]): Point {
    return {
      type: 'Point',
      coordinates: [Number(longitude), Number(latitude)],
    };
  }

  private async sanitizeTrip(trip: Trip): Promise<SanitizedTrip> {
    const { driver, bookings, departurePoint, arrivalPoint, ...rest } = trip;

    return {
      ...(rest as Omit<Trip, 'driver' | 'bookings' | 'departurePoint' | 'arrivalPoint'>),
      departureCoordinates: this.pointToCoordinates(departurePoint),
      arrivalCoordinates: this.pointToCoordinates(arrivalPoint),
      driver: await this.sanitizeUser(driver),
      bookings: bookings ? await Promise.all(bookings.map((booking) => this.sanitizeBooking(booking))) : [],
    } as SanitizedTrip;
  }

  private async sanitizeBooking(booking: Booking): Promise<SanitizedBooking> {
    const { passenger, trip, messages, ...rest } = booking;
    return {
      ...(rest as Omit<Booking, 'trip' | 'passenger' | 'messages'>),
      passenger: await this.sanitizeUser(passenger),
    } as SanitizedBooking;
  }

  private async sanitizeUser(user?: User): Promise<SanitizedUser | null> {
    if (!user) {
      return null;
    }

    // Convert S3 key to presigned URL
    const profilePicture = user.profilePicture
      ? await this.fileUploadService.getPresignedUrlIfS3Key(user.profilePicture)
      : null;

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      profilePicture: profilePicture || user.profilePicture,
      role: user.role,
      status: user.status,
      isDriver: user.isDriver,
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
      throw new NotFoundException('Trip not found');
    }

    const isDriver = trip.driverId === userId;
    const isPassenger =
      trip.bookings?.some(
        (booking) =>
          booking.passengerId === userId &&
          booking.status === BookingStatus.ACCEPTED,
      ) ?? false;

    if (!isDriver && !isPassenger) {
      throw new ForbiddenException('You are not part of this trip');
    }

    return { trip, isDriver, isPassenger };
  }

  async ensureUserCanTrackTrip(tripId: string, userId: string) {
    await this.verifyTripParticipant(tripId, userId);
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
      throw new ForbiddenException('Only the driver can update location');
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
    return {
      tripId: trip.id,
      coordinates: this.pointToCoordinates(trip.currentLocation),
      updatedAt: trip.lastLocationUpdateAt,
    };
  }
}

