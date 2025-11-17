import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking, BookingStatus } from './entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { CreateBookingDto, UpdateBookingStatusDto } from './dto/booking.dto';
import { CacheService } from '../common/services/cache.service';

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);
  private readonly CACHE_TTL = 180; // 3 minutes

  constructor(
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(Trip)
    private tripRepository: Repository<Trip>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private cacheService: CacheService,
  ) {}

  async create(passengerId: string, createBookingDto: CreateBookingDto): Promise<Booking> {
    this.logger.log(`Creating booking for passenger ${passengerId} on trip ${createBookingDto.tripId} (${createBookingDto.numberOfSeats} seats)`);
    
    const trip = await this.tripRepository.findOne({
      where: { id: createBookingDto.tripId },
      relations: ['bookings'],
    });

    if (!trip) {
      this.logger.warn(`Booking creation failed: Trip ${createBookingDto.tripId} not found`);
      throw new NotFoundException('Trip not found');
    }

    if (trip.driverId === passengerId) {
      this.logger.warn(`Booking creation failed: Passenger ${passengerId} tried to book own trip ${createBookingDto.tripId}`);
      throw new BadRequestException('Cannot book your own trip');
    }

    if (trip.status !== TripStatus.PENDING) {
      this.logger.warn(`Booking creation failed: Trip ${createBookingDto.tripId} is not available (status: ${trip.status})`);
      throw new BadRequestException('Trip is not available for booking');
    }

    // Check available seats
    const totalBookedSeats = trip.bookings
      .filter((b) => b.status === BookingStatus.ACCEPTED)
      .reduce((sum, b) => sum + b.numberOfSeats, 0);

    if (totalBookedSeats + createBookingDto.numberOfSeats > trip.availableSeats) {
      this.logger.warn(`Booking creation failed: Not enough seats on trip ${createBookingDto.tripId} (requested: ${createBookingDto.numberOfSeats}, available: ${trip.availableSeats - totalBookedSeats})`);
      throw new BadRequestException('Not enough available seats');
    }

    // Check if user already has a pending booking for this trip
    const existingBooking = await this.bookingRepository.findOne({
      where: {
        tripId: createBookingDto.tripId,
        passengerId,
        status: BookingStatus.PENDING,
      },
    });

    if (existingBooking) {
      this.logger.warn(`Booking creation failed: Passenger ${passengerId} already has pending booking for trip ${createBookingDto.tripId}`);
      throw new BadRequestException('You already have a pending booking for this trip');
    }

    const booking = this.bookingRepository.create({
      ...createBookingDto,
      passengerId,
    });

    const savedBooking = await this.bookingRepository.save(booking);
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getBookingsByTripKey(createBookingDto.tripId));
    await this.cacheService.del(CacheService.getBookingsByPassengerKey(passengerId));
    await this.cacheService.del(CacheService.getTripKey(createBookingDto.tripId));

    this.logger.log(`Booking created successfully: ${savedBooking.id} for passenger ${passengerId} on trip ${createBookingDto.tripId}`);
    return savedBooking;
  }

  async findAllByPassenger(passengerId: string): Promise<Booking[]> {
    this.logger.debug(`Fetching bookings for passenger: ${passengerId}`);
    
    const cacheKey = CacheService.getBookingsByPassengerKey(passengerId);
    const cached = await this.cacheService.get<Booking[]>(cacheKey);
    
    if (cached) {
      this.logger.debug(`Returning ${cached.length} bookings from cache for passenger ${passengerId}`);
      return cached;
    }

    const bookings = await this.bookingRepository.find({
      where: { passengerId },
      relations: ['trip', 'trip.driver'],
      order: { createdAt: 'DESC' },
    });

    await this.cacheService.set(cacheKey, bookings, this.CACHE_TTL);
    this.logger.debug(`Fetched ${bookings.length} bookings from database for passenger ${passengerId}`);
    return bookings;
  }

  async findAllByTrip(tripId: string, driverId: string): Promise<Booking[]> {
    this.logger.debug(`Fetching bookings for trip ${tripId} by driver ${driverId}`);
    
    const trip = await this.tripRepository.findOne({
      where: { id: tripId, driverId },
    });

    if (!trip) {
      this.logger.warn(`Get bookings failed: Trip ${tripId} not found for driver ${driverId}`);
      throw new NotFoundException('Trip not found');
    }

    const cacheKey = CacheService.getBookingsByTripKey(tripId);
    const cached = await this.cacheService.get<Booking[]>(cacheKey);
    
    if (cached) {
      this.logger.debug(`Returning ${cached.length} bookings from cache for trip ${tripId}`);
      return cached;
    }

    const bookings = await this.bookingRepository.find({
      where: { tripId },
      relations: ['passenger'],
      order: { createdAt: 'DESC' },
    });

    await this.cacheService.set(cacheKey, bookings, this.CACHE_TTL);
    this.logger.debug(`Fetched ${bookings.length} bookings from database for trip ${tripId}`);
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
      throw new NotFoundException('Booking not found');
    }

    await this.cacheService.set(cacheKey, booking, this.CACHE_TTL);
    this.logger.debug(`Booking ${id} fetched from database`);
    return booking;
  }

  async updateStatus(
    bookingId: string,
    driverId: string,
    updateStatusDto: UpdateBookingStatusDto,
  ): Promise<Booking> {
    this.logger.log(`Updating booking ${bookingId} status to ${updateStatusDto.status} by driver ${driverId}`);
    
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip'],
    });

    if (!booking) {
      this.logger.warn(`Booking status update failed: Booking ${bookingId} not found`);
      throw new NotFoundException('Booking not found');
    }

    if (booking.trip.driverId !== driverId) {
      this.logger.warn(`Booking status update failed: Driver ${driverId} tried to update booking ${bookingId} (owner: ${booking.trip.driverId})`);
      throw new BadRequestException('Only the trip driver can update booking status');
    }

    if (updateStatusDto.status === BookingStatus.ACCEPTED) {
      booking.acceptedAt = new Date();
    } else if (updateStatusDto.status === BookingStatus.CANCELLED) {
      booking.cancelledAt = new Date();
    }

    if (updateStatusDto.rejectionReason) {
      booking.rejectionReason = updateStatusDto.rejectionReason;
    }

    booking.status = updateStatusDto.status;
    const updatedBooking = await this.bookingRepository.save(booking);
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getBookingKey(bookingId));
    await this.cacheService.del(CacheService.getBookingsByTripKey(booking.tripId));
    await this.cacheService.del(CacheService.getBookingsByPassengerKey(booking.passengerId));
    await this.cacheService.del(CacheService.getTripKey(booking.tripId));

    this.logger.log(`Booking ${bookingId} status updated to ${updateStatusDto.status} successfully`);
    return updatedBooking;
  }

  async cancel(bookingId: string, passengerId: string): Promise<void> {
    this.logger.log(`Cancelling booking ${bookingId} by passenger ${passengerId}`);
    
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
    });

    if (!booking) {
      this.logger.warn(`Booking cancellation failed: Booking ${bookingId} not found for passenger ${passengerId}`);
      throw new NotFoundException('Booking not found');
    }

    if (booking.status === BookingStatus.COMPLETED) {
      this.logger.warn(`Booking cancellation failed: Booking ${bookingId} is already completed`);
      throw new BadRequestException('Cannot cancel a completed booking');
    }

    booking.status = BookingStatus.CANCELLED;
    booking.cancelledAt = new Date();
    await this.bookingRepository.save(booking);
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getBookingKey(bookingId));
    await this.cacheService.del(CacheService.getBookingsByPassengerKey(passengerId));
    
    // Get tripId from booking to invalidate trip cache
    const bookingWithTrip = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip'],
    });
    if (bookingWithTrip) {
      await this.cacheService.del(CacheService.getBookingsByTripKey(bookingWithTrip.tripId));
      await this.cacheService.del(CacheService.getTripKey(bookingWithTrip.tripId));
    }

    this.logger.log(`Booking ${bookingId} cancelled successfully`);
  }
}

