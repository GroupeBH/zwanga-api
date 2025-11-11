import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking, BookingStatus } from './entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { CreateBookingDto, UpdateBookingStatusDto } from './dto/booking.dto';

@Injectable()
export class BookingsService {
  constructor(
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(Trip)
    private tripRepository: Repository<Trip>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  async create(passengerId: string, createBookingDto: CreateBookingDto): Promise<Booking> {
    const trip = await this.tripRepository.findOne({
      where: { id: createBookingDto.tripId },
      relations: ['bookings'],
    });

    if (!trip) {
      throw new NotFoundException('Trip not found');
    }

    if (trip.driverId === passengerId) {
      throw new BadRequestException('Cannot book your own trip');
    }

    if (trip.status !== TripStatus.PENDING) {
      throw new BadRequestException('Trip is not available for booking');
    }

    // Check available seats
    const totalBookedSeats = trip.bookings
      .filter((b) => b.status === BookingStatus.ACCEPTED)
      .reduce((sum, b) => sum + b.numberOfSeats, 0);

    if (totalBookedSeats + createBookingDto.numberOfSeats > trip.availableSeats) {
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
      throw new BadRequestException('You already have a pending booking for this trip');
    }

    const booking = this.bookingRepository.create({
      ...createBookingDto,
      passengerId,
    });

    return await this.bookingRepository.save(booking);
  }

  async findAllByPassenger(passengerId: string): Promise<Booking[]> {
    return this.bookingRepository.find({
      where: { passengerId },
      relations: ['trip', 'trip.driver'],
      order: { createdAt: 'DESC' },
    });
  }

  async findAllByTrip(tripId: string, driverId: string): Promise<Booking[]> {
    const trip = await this.tripRepository.findOne({
      where: { id: tripId, driverId },
    });

    if (!trip) {
      throw new NotFoundException('Trip not found');
    }

    return this.bookingRepository.find({
      where: { tripId },
      relations: ['passenger'],
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Booking> {
    const booking = await this.bookingRepository.findOne({
      where: { id },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    return booking;
  }

  async updateStatus(
    bookingId: string,
    driverId: string,
    updateStatusDto: UpdateBookingStatusDto,
  ): Promise<Booking> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip'],
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.trip.driverId !== driverId) {
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
    return await this.bookingRepository.save(booking);
  }

  async cancel(bookingId: string, passengerId: string): Promise<void> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.status === BookingStatus.COMPLETED) {
      throw new BadRequestException('Cannot cancel a completed booking');
    }

    booking.status = BookingStatus.CANCELLED;
    booking.cancelledAt = new Date();
    await this.bookingRepository.save(booking);
  }
}

