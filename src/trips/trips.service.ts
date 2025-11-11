import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Trip, TripStatus } from './entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { CreateTripDto, SearchTripsDto, UpdateTripDto } from './dto/trip.dto';

@Injectable()
export class TripsService {
  constructor(
    @InjectRepository(Trip)
    private tripRepository: Repository<Trip>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  async create(driverId: string, createTripDto: CreateTripDto): Promise<Trip> {
    const driver = await this.userRepository.findOne({ where: { id: driverId } });
    if (!driver) {
      throw new NotFoundException('Driver not found');
    }

    if (driver.role !== 'driver') {
      throw new BadRequestException('User must be a driver to create trips');
    }

    const trip = this.tripRepository.create({
      ...createTripDto,
      driverId,
      departureDate: new Date(createTripDto.departureDate),
    });

    return await this.tripRepository.save(trip);
  }

  async findAll(): Promise<Trip[]> {
    return this.tripRepository.find({
      relations: ['driver', 'bookings'],
      where: { status: TripStatus.PENDING },
      order: { departureDate: 'ASC' },
    });
  }

  async search(searchTripsDto: SearchTripsDto): Promise<Trip[]> {
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

    return queryBuilder.getMany();
  }

  async findOne(id: string): Promise<Trip> {
    const trip = await this.tripRepository.findOne({
      where: { id },
      relations: ['driver', 'driver.vehicles', 'bookings', 'bookings.passenger'],
    });

    if (!trip) {
      throw new NotFoundException('Trip not found');
    }

    return trip;
  }

  async findByDriver(driverId: string): Promise<Trip[]> {
    return this.tripRepository.find({
      where: { driverId },
      relations: ['bookings'],
      order: { departureDate: 'DESC' },
    });
  }

  async update(id: string, driverId: string, updateTripDto: UpdateTripDto): Promise<Trip> {
    const trip = await this.tripRepository.findOne({
      where: { id, driverId },
    });

    if (!trip) {
      throw new NotFoundException('Trip not found');
    }

    if (updateTripDto.departureDate) {
      trip.departureDate = new Date(updateTripDto.departureDate);
      delete updateTripDto.departureDate;
    }

    Object.assign(trip, updateTripDto);
    return await this.tripRepository.save(trip);
  }

  async remove(id: string, driverId: string): Promise<void> {
    const trip = await this.tripRepository.findOne({
      where: { id, driverId },
    });

    if (!trip) {
      throw new NotFoundException('Trip not found');
    }

    await this.tripRepository.remove(trip);
  }
}

