import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Trip, TripStatus } from './entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { CreateTripDto, SearchTripsDto, UpdateTripDto } from './dto/trip.dto';
import { CacheService } from '../common/services/cache.service';

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);
  private readonly CACHE_TTL = 300; // 5 minutes

  constructor(
    @InjectRepository(Trip)
    private tripRepository: Repository<Trip>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private cacheService: CacheService,
  ) {}

  async create(driverId: string, createTripDto: CreateTripDto): Promise<Trip> {
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

    const trip = this.tripRepository.create({
      ...createTripDto,
      driverId,
      departureDate: new Date(createTripDto.departureDate),
    });

    const savedTrip = await this.tripRepository.save(trip);
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getTripsListKey());
    await this.cacheService.del(CacheService.getTripsListKey('all'));

    this.logger.log(`Trip created successfully: ${savedTrip.id} by driver ${driverId}`);
    return savedTrip;
  }

  async findAll(): Promise<Trip[]> {
    this.logger.debug('Fetching all trips');
    
    const cacheKey = CacheService.getTripsListKey('all');
    const cached = await this.cacheService.get<Trip[]>(cacheKey);
    
    if (cached) {
      this.logger.debug(`Returning ${cached.length} trips from cache`);
      return cached;
    }

    const trips = await this.tripRepository.find({
      relations: ['driver', 'bookings'],
      where: { status: TripStatus.PENDING },
      order: { departureDate: 'ASC' },
    });

    await this.cacheService.set(cacheKey, trips, this.CACHE_TTL);
    this.logger.log(`Fetched ${trips.length} trips from database`);
    return trips;
  }

  async search(searchTripsDto: SearchTripsDto): Promise<Trip[]> {
    this.logger.log(`Searching trips with filters: ${JSON.stringify(searchTripsDto)}`);
    
    const queryBuilder = this.tripRepository
      .createQueryBuilder('trip')
      .leftJoinAndSelect('trip.driver', 'driver')
      .leftJoinAndSelect('trip.bookings', 'bookings')
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
    if (
      searchTripsDto.departureLatitude &&
      searchTripsDto.departureLongitude
    ) {
      // Simple radius search (50km radius)
      const radius = 0.5; // approximately 50km
      queryBuilder.andWhere(
        'ABS(trip.departureLatitude - :depLat) <= :radius AND ABS(trip.departureLongitude - :depLng) <= :radius',
        {
          depLat: searchTripsDto.departureLatitude,
          depLng: searchTripsDto.departureLongitude,
          radius,
        },
      );
    }

    queryBuilder.orderBy('trip.departureDate', 'ASC');

    const results = await queryBuilder.getMany();
    this.logger.log(`Trip search returned ${results.length} results`);
    return results;
  }

  async findOne(id: string): Promise<Trip> {
    this.logger.debug(`Fetching trip: ${id}`);
    
    const cacheKey = CacheService.getTripKey(id);
    const cached = await this.cacheService.get<Trip>(cacheKey);
    
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

    await this.cacheService.set(cacheKey, trip, this.CACHE_TTL);
    this.logger.debug(`Trip ${id} fetched from database`);
    return trip;
  }

  async findByDriver(driverId: string): Promise<Trip[]> {
    this.logger.debug(`Fetching trips for driver: ${driverId}`);
    
    const trips = await this.tripRepository.find({
      where: { driverId },
      relations: ['bookings'],
      order: { departureDate: 'DESC' },
    });

    this.logger.debug(`Found ${trips.length} trips for driver ${driverId}`);
    return trips;
  }

  async update(id: string, driverId: string, updateTripDto: UpdateTripDto): Promise<Trip> {
    this.logger.log(`Updating trip ${id} by driver ${driverId}`);
    
    const trip = await this.tripRepository.findOne({
      where: { id, driverId },
    });

    if (!trip) {
      this.logger.warn(`Trip update failed: Trip ${id} not found for driver ${driverId}`);
      throw new NotFoundException('Trip not found');
    }

    if (updateTripDto.departureDate) {
      trip.departureDate = new Date(updateTripDto.departureDate);
      delete updateTripDto.departureDate;
    }

    Object.assign(trip, updateTripDto);
    const updatedTrip = await this.tripRepository.save(trip);
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getTripKey(id));
    await this.cacheService.del(CacheService.getTripsListKey());
    await this.cacheService.del(CacheService.getTripsListKey('all'));

    this.logger.log(`Trip ${id} updated successfully`);
    return updatedTrip;
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
}

