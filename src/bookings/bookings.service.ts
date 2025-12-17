import { Injectable, NotFoundException, BadRequestException, Logger, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking, BookingStatus } from './entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { CreateBookingDto, UpdateBookingStatusDto } from './dto/booking.dto';
import { CacheService } from '../common/services/cache.service';
import { NotificationService } from '../notifications/notifications.service';
import { ChatService } from '../chat/chat.service';
import { FileUploadService } from '../common/services/file-upload.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { SafetyService } from '../safety/safety.service';
import { SendWhatsAppNotificationDto } from './dto/send-whatsapp-notification.dto';

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
    private notificationService: NotificationService,
    private chatService: ChatService,
    private fileUploadService: FileUploadService,
    private whatsAppService: WhatsAppService,
    private safetyService: SafetyService,
  ) {}

  async create(passengerId: string, createBookingDto: CreateBookingDto): Promise<Booking> {
    this.logger.log(`Creating booking for passenger ${passengerId} on trip ${createBookingDto.tripId} (${createBookingDto.numberOfSeats} seats)`);
    
    const trip = await this.tripRepository.findOne({
      where: { id: createBookingDto.tripId },
      relations: ['bookings', 'driver'],
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
    
    await this.chatService.ensureConversationForBooking(savedBooking.id);

    // Invalidate cache
    await this.cacheService.del(CacheService.getBookingsByTripKey(createBookingDto.tripId));
    await this.cacheService.del(CacheService.getBookingsByPassengerKey(passengerId));
    await this.cacheService.del(CacheService.getTripKey(createBookingDto.tripId));

    this.logger.log(`Booking created successfully: ${savedBooking.id} for passenger ${passengerId} on trip ${createBookingDto.tripId}`);

    await this.notifyDriverOfNewBooking(trip, passengerId, savedBooking);
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
      relations: ['passenger', 'trip', 'trip.driver'],
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
      booking.rejectionReason = null;
    } else if (updateStatusDto.status === BookingStatus.CANCELLED) {
      booking.cancelledAt = new Date();
    } else if (updateStatusDto.status === BookingStatus.REJECTED) {
      if (!updateStatusDto.rejectionReason?.trim()) {
        this.logger.warn(`Driver ${driverId} tried to reject booking ${bookingId} without reason`);
        throw new BadRequestException('Rejection reason is required when rejecting a booking');
      }
      booking.rejectionReason = updateStatusDto.rejectionReason.trim();
      booking.acceptedAt = null;
    } else {
      booking.rejectionReason = null;
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

  async acceptBooking(bookingId: string, driverId: string): Promise<Booking> {
    const booking = await this.updateStatus(bookingId, driverId, {
      status: BookingStatus.ACCEPTED,
    });
    await this.notifyPassengerOfStatusChange(booking, BookingStatus.ACCEPTED);
    return booking;
  }

  async rejectBooking(bookingId: string, driverId: string, reason: string): Promise<Booking> {
    const booking = await this.updateStatus(bookingId, driverId, {
      status: BookingStatus.REJECTED,
      rejectionReason: reason,
    });
    await this.notifyPassengerOfStatusChange(booking, BookingStatus.REJECTED, reason);
    return booking;
  }

  async getDriverContact(bookingId: string, requesterId: string) {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'trip.driver'],
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (
      booking.passengerId !== requesterId &&
      booking.trip.driverId !== requesterId
    ) {
      throw new ForbiddenException('Access denied');
    }

    const driver = booking.trip.driver;

    if (!driver) {
      throw new NotFoundException('Driver not found');
    }

    // Convert S3 key to presigned URL
    const profilePicture = driver.profilePicture
      ? await this.fileUploadService.getPresignedUrlIfS3Key(driver.profilePicture)
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

      if (booking.status === BookingStatus.REJECTED && booking.rejectionReason) {
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
      this.logger.error(`Failed to send passenger notification: ${error.message}`, error.stack);
    }
  }

  private async notifyDriverOfNewBooking(trip: Trip, passengerId: string, booking: Booking) {
    try {
      const driver = trip.driver ?? (await this.userRepository.findOne({ where: { id: trip.driverId } }));

      if (!driver?.fcmToken) {
        this.logger.debug(`Driver ${trip.driverId} has no FCM token, skipping notification`);
        return;
      }

      const passenger = await this.userRepository.findOne({ where: { id: passengerId } });
      const passengerName = passenger ? `${passenger.firstName} ${passenger.lastName}` : 'Un passager';

      await this.notificationService.sendNotification(
        driver.fcmToken,
        'Nouvelle réservation',
        `${passengerName} a réservé ${booking.numberOfSeats} place(s) sur votre trajet ${trip.departureLocation} → ${trip.arrivalLocation}`,
        {
          bookingId: booking.id,
          tripId: trip.id,
        },
        trip.driverId,
      );
    } catch (error) {
      this.logger.error(`Failed to send booking notification: ${error.message}`, error.stack);
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
    const emergencyContacts = await this.safetyService.findAllEmergencyContacts(passengerId);
    const selectedContacts = emergencyContacts.filter((contact) =>
      sendDto.emergencyContactIds.includes(contact.id),
    );

    if (selectedContacts.length !== sendDto.emergencyContactIds.length) {
      throw new BadRequestException('Certains contacts d\'urgence sélectionnés n\'existent pas');
    }

    // Vérifier que tous les contacts sont actifs
    const inactiveContacts = selectedContacts.filter((contact) => !contact.isActive);
    if (inactiveContacts.length > 0) {
      throw new BadRequestException(
        `Certains contacts d'urgence ne sont pas actifs: ${inactiveContacts.map((c) => c.name).join(', ')}`,
      );
    }

    // Récupérer les informations du véhicule
    const trip = booking.trip;
    if (!trip.vehicle) {
      throw new BadRequestException('Aucun véhicule associé à ce trajet');
    }

    const vehicle = trip.vehicle;
    const driver = trip.driver || (await this.userRepository.findOne({ where: { id: trip.driverId } }));
    const passenger = booking.passenger || (await this.userRepository.findOne({ where: { id: passengerId } }));

    if (!driver) {
      throw new NotFoundException('Conducteur non trouvé');
    }

    if (!passenger) {
      throw new NotFoundException('Passager non trouvé');
    }

    // Générer le message WhatsApp
    const message = this.whatsAppService.generateTripNotificationMessage({
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
}

