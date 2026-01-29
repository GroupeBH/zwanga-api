import { Injectable, NotFoundException, BadRequestException, Logger, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import type { Point } from 'typeorm';
import { Booking, BookingStatus } from './entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { CreateBookingDto, UpdateBookingStatusDto, ReportBookingProblemDto, UpdatePassengerLocationDto } from './dto/booking.dto';
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
  private readonly DESTINATION_PROXIMITY_THRESHOLD_METERS = 1000; // 1 km

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
      throw new NotFoundException('Trajet non trouvé');
    }

    if (trip.driverId === passengerId) {
      this.logger.warn(`Booking creation failed: Passenger ${passengerId} tried to book own trip ${createBookingDto.tripId}`);
      throw new BadRequestException('Vous ne pouvez pas réserver votre propre trajet');
    }

    // Allow booking for PENDING trips OR ACTIVE trips with available seats
    const isPendingTrip = trip.status === TripStatus.PENDING;
    const isActiveTripWithSeats = trip.status === TripStatus.ACTIVE && trip.availableSeats > 0;
    
    if (!isPendingTrip && !isActiveTripWithSeats) {
      this.logger.warn(`Booking creation failed: Trip ${createBookingDto.tripId} is not available for booking (status: ${trip.status}, availableSeats: ${trip.availableSeats})`);
      throw new BadRequestException('Ce trajet n\'est pas disponible pour la réservation. Seuls les trajets en attente ou les trajets actifs avec des places disponibles peuvent être réservés.');
    }

    // Vérifier les places disponibles directement (les places sont déduites immédiatement à la création)
    // Le maximum de places qu'un utilisateur peut réserver est limité uniquement par les places disponibles
    if (trip.availableSeats < createBookingDto.numberOfSeats) {
      this.logger.warn(
        `Booking creation failed: Not enough seats on trip ${createBookingDto.tripId} (requested: ${createBookingDto.numberOfSeats}, available: ${trip.availableSeats})`,
      );
      throw new BadRequestException(
        `Pas assez de places disponibles. Disponibles : ${trip.availableSeats}, Demandées : ${createBookingDto.numberOfSeats}. Vous pouvez réserver jusqu'à ${trip.availableSeats} place(s).`,
      );
    }

    // Check if user already has a pending or accepted booking for this trip
    // For ACTIVE trips, also check ACCEPTED bookings to prevent double booking
    const statusesToCheck = trip.status === TripStatus.ACTIVE
      ? [BookingStatus.PENDING, BookingStatus.ACCEPTED]
      : [BookingStatus.PENDING];
    
    const existingBooking = await this.bookingRepository.findOne({
      where: {
        tripId: createBookingDto.tripId,
        passengerId,
        status: In(statusesToCheck),
      },
    });

    if (existingBooking) {
      const statusText = trip.status === TripStatus.ACTIVE 
        ? 'pending or accepted' 
        : 'pending';
      this.logger.warn(`Booking creation failed: Passenger ${passengerId} already has ${statusText} booking for trip ${createBookingDto.tripId}`);
      throw new BadRequestException(`Vous avez déjà une réservation ${statusText === 'pending or accepted' ? 'en attente ou acceptée' : 'en attente'} pour ce trajet`);
    }

    // Build passenger destination point if coordinates are provided
    let passengerDestinationPoint: Point | null = null;
    if (createBookingDto.passengerDestinationCoordinates) {
      passengerDestinationPoint = {
        type: 'Point',
        coordinates: [
          Number(createBookingDto.passengerDestinationCoordinates.longitude),
          Number(createBookingDto.passengerDestinationCoordinates.latitude),
        ],
      };
    }

    // Use trip's arrival location as default if passenger destination is not specified
    const passengerDestination = createBookingDto.passengerDestination || trip.arrivalLocation;
    
    // If no coordinates provided but destination is specified, use trip's arrival point
    if (!passengerDestinationPoint && createBookingDto.passengerDestination) {
      passengerDestinationPoint = trip.arrivalPoint;
    }

    const booking = this.bookingRepository.create({
      tripId: createBookingDto.tripId,
      passengerId,
      numberOfSeats: createBookingDto.numberOfSeats,
      passengerDestination: passengerDestination || null,
      passengerDestinationPoint,
    });

    const savedBooking = await this.bookingRepository.save(booking);
    
    // Déduire immédiatement les places disponibles du trip
    // Les places sont déduites dès la création (même en PENDING) pour éviter les sur-réservations
    const newAvailableSeats = trip.availableSeats - createBookingDto.numberOfSeats;
    if (newAvailableSeats < 0) {
      // Ce cas ne devrait pas arriver car on a déjà vérifié, mais on le gère pour sécurité
      this.logger.error(`Negative available seats detected for trip ${trip.id}. Rolling back booking.`);
      await this.bookingRepository.remove(savedBooking);
      throw new BadRequestException('Pas assez de places disponibles');
    }

    // S'assurer que availableSeats ne dépasse pas totalSeats (ou availableSeats si totalSeats est null temporairement)
    const maxSeats = trip.totalSeats ?? trip.availableSeats + createBookingDto.numberOfSeats; // Fallback si totalSeats est null
    const finalAvailableSeats = Math.max(0, Math.min(newAvailableSeats, maxSeats));
    
    await this.tripRepository.update(trip.id, {
      availableSeats: finalAvailableSeats,
    });

    this.logger.log(
      `Updated trip ${trip.id} available seats: ${trip.availableSeats} -> ${finalAvailableSeats} (deducted ${createBookingDto.numberOfSeats} for booking ${savedBooking.id}, totalSeats: ${trip.totalSeats})`,
    );
    
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
      throw new NotFoundException('Trajet non trouvé');
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
      throw new NotFoundException('Réservation non trouvée');
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
      throw new NotFoundException('Réservation non trouvée');
    }

    if (booking.trip.driverId !== driverId) {
      this.logger.warn(`Booking status update failed: Driver ${driverId} tried to update booking ${bookingId} (owner: ${booking.trip.driverId})`);
      throw new BadRequestException('Seul le conducteur du trajet peut modifier le statut de la réservation');
    }

    const oldStatus = booking.status;
    const trip = await this.tripRepository.findOne({ where: { id: booking.tripId } });

    if (!trip) {
      throw new NotFoundException('Trajet non trouvé');
    }

    if (updateStatusDto.status === BookingStatus.ACCEPTED) {
      booking.acceptedAt = new Date();
      booking.rejectionReason = null;
      // Les places ont déjà été déduites lors de la création, donc pas besoin de les déduire à nouveau
    } else if (updateStatusDto.status === BookingStatus.CANCELLED) {
      booking.cancelledAt = new Date();
      // Remettre les places disponibles si la réservation était en PENDING ou ACCEPTED
      if (oldStatus === BookingStatus.PENDING || oldStatus === BookingStatus.ACCEPTED) {
        const maxSeats = trip.totalSeats ?? trip.availableSeats + booking.numberOfSeats; // Fallback si totalSeats est null
        const newAvailableSeats = Math.min(maxSeats, trip.availableSeats + booking.numberOfSeats);
        await this.tripRepository.update(trip.id, {
          availableSeats: newAvailableSeats,
        });
        this.logger.log(
          `Restored ${booking.numberOfSeats} seats for trip ${trip.id} (booking ${bookingId} cancelled). New available seats: ${newAvailableSeats} (totalSeats: ${trip.totalSeats})`,
        );
      }
    } else if (updateStatusDto.status === BookingStatus.REJECTED) {
      if (!updateStatusDto.rejectionReason?.trim()) {
        this.logger.warn(`Driver ${driverId} tried to reject booking ${bookingId} without reason`);
        throw new BadRequestException('Un motif de refus est requis lors du rejet d\'une réservation');
      }
      booking.rejectionReason = updateStatusDto.rejectionReason.trim();
      booking.acceptedAt = null;
      // Remettre les places disponibles si la réservation était en PENDING ou ACCEPTED
      if (oldStatus === BookingStatus.PENDING || oldStatus === BookingStatus.ACCEPTED) {
        const maxSeats = trip.totalSeats ?? trip.availableSeats + booking.numberOfSeats; // Fallback si totalSeats est null
        const newAvailableSeats = Math.min(maxSeats, trip.availableSeats + booking.numberOfSeats);
        await this.tripRepository.update(trip.id, {
          availableSeats: newAvailableSeats,
        });
        this.logger.log(
          `Restored ${booking.numberOfSeats} seats for trip ${trip.id} (booking ${bookingId} rejected). New available seats: ${newAvailableSeats} (totalSeats: ${trip.totalSeats})`,
        );
      }
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
      relations: ['passenger'],
    });

    if (!booking) {
      this.logger.warn(`Booking cancellation failed: Booking ${bookingId} not found for passenger ${passengerId}`);
      throw new NotFoundException('Réservation non trouvée');
    }

    if (booking.status === BookingStatus.COMPLETED) {
      this.logger.warn(`Booking cancellation failed: Booking ${bookingId} is already completed`);
      throw new BadRequestException('Impossible d\'annuler une réservation terminée');
    }

    const oldStatus = booking.status;
    const trip = await this.tripRepository.findOne({ 
      where: { id: booking.tripId },
      relations: ['driver'],
    });

    if (!trip) {
      throw new NotFoundException('Trajet non trouvé');
    }

    booking.status = BookingStatus.CANCELLED;
    booking.cancelledAt = new Date();
    await this.bookingRepository.save(booking);

    // Remettre les places disponibles si la réservation était en PENDING ou ACCEPTED
    if (oldStatus === BookingStatus.PENDING || oldStatus === BookingStatus.ACCEPTED) {
      const maxSeats = trip.totalSeats ?? trip.availableSeats + booking.numberOfSeats; // Fallback si totalSeats est null
      const newAvailableSeats = Math.min(maxSeats, trip.availableSeats + booking.numberOfSeats);
      await this.tripRepository.update(trip.id, {
        availableSeats: newAvailableSeats,
      });
      this.logger.log(
        `Restored ${booking.numberOfSeats} seats for trip ${trip.id} (booking ${bookingId} cancelled by passenger). New available seats: ${newAvailableSeats} (totalSeats: ${trip.totalSeats})`,
      );
    }

    // Si c'est un trajet privé, terminer automatiquement le trajet et notifier le driver
    if (trip.isPrivate) {
      this.logger.log(`Private trip ${trip.id} - Passenger cancelled booking. Terminating trip automatically.`);
      
      // Terminer le trajet
      trip.status = TripStatus.COMPLETED;
      trip.completedAt = new Date();
      await this.tripRepository.save(trip);

      // Notifier le driver
      await this.notifyDriverAboutPrivateTripCancellation(trip, booking);
    }
    
    // Invalidate cache
    await this.cacheService.del(CacheService.getBookingKey(bookingId));
    await this.cacheService.del(CacheService.getBookingsByPassengerKey(passengerId));
    await this.cacheService.del(CacheService.getBookingsByTripKey(booking.tripId));
    await this.cacheService.del(CacheService.getTripKey(booking.tripId));

    this.logger.log(`Booking ${bookingId} cancelled successfully!`);
  }

  /**
   * Notifie le conducteur qu'un trajet privé a été terminé à cause de l'annulation du passager
   */
  private async notifyDriverAboutPrivateTripCancellation(trip: Trip, cancelledBooking: Booking): Promise<void> {
    try {
      if (!trip.driver?.fcmToken) {
        this.logger.debug(`Driver ${trip.driverId} has no FCM token, skipping notification`);
        return;
      }

      const passengerName = cancelledBooking.passenger 
        ? `${cancelledBooking.passenger.firstName} ${cancelledBooking.passenger.lastName}`
        : 'Le passager';

      const title = '🚫 Trajet terminé';
      const body = `${passengerName} a annulé sa réservation. Le trajet privé de ${trip.departureLocation} à ${trip.arrivalLocation} a été automatiquement terminé.`;

      const data = {
        type: 'private_trip_cancelled',
        tripId: trip.id,
        bookingId: cancelledBooking.id,
        passengerId: cancelledBooking.passengerId,
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
      this.logger.log(`Notified driver ${trip.driverId} about private trip ${trip.id} cancellation`);
    } catch (error) {
      this.logger.error(
        `Error notifying driver about private trip cancellation ${trip.id}: ${error.message}`,
        error.stack,
      );
    }
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
      throw new NotFoundException('Réservation non trouvée');
    }

    if (
      booking.passengerId !== requesterId &&
      booking.trip.driverId !== requesterId
    ) {
      throw new ForbiddenException('Accès refusé');
    }

    const driver = booking.trip.driver;

    if (!driver) {
      throw new NotFoundException('Conducteur non trouvé');
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
      
      // Build destination message
      const destination = booking.passengerDestination || trip.arrivalLocation;
      const destinationMessage = booking.passengerDestination && booking.passengerDestination !== trip.arrivalLocation
        ? `${trip.departureLocation} → ${destination} (destination personnalisée)`
        : `${trip.departureLocation} → ${trip.arrivalLocation}`;

      await this.notificationService.sendNotification(
        driver.fcmToken,
        'Nouvelle réservation',
        `${passengerName} a réservé ${booking.numberOfSeats} place(s) sur votre trajet ${destinationMessage}`,
        {
          bookingId: booking.id,
          tripId: trip.id,
          passengerDestination: destination,
          role: 'driver',
          driverId: trip.driverId,
        },
        trip.driverId,
      );
    } catch (error) {
      this.logger.error(`Failed to send booking notification: ${error.message}`, error.stack);
    }
  }

  async confirmPickup(bookingId: string, driverId: string): Promise<Booking> {
    this.logger.log(`Driver ${driverId} confirming pickup for booking ${bookingId}`);

    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Réservation non trouvée');
    }

    if (booking.trip.driverId !== driverId) {
      throw new ForbiddenException('Vous n\'êtes pas le conducteur de ce trajet');
    }

    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException('La réservation doit être acceptée avant de confirmer la prise en charge');
    }

    if (booking.pickedUp) {
      throw new BadRequestException('Le passager est déjà marqué comme pris en charge');
    }

    booking.pickedUp = true;
    booking.pickedUpAt = new Date();
    await this.bookingRepository.save(booking);

    // Notify passenger
    await this.notifyPassengerAboutPickupConfirmation(booking);

    // Invalidate cache
    await this.cacheService.del(CacheService.getBookingsByTripKey(booking.tripId));
    await this.cacheService.del(CacheService.getBookingsByPassengerKey(booking.passengerId));

    this.logger.log(`Pickup confirmed for booking ${bookingId}`);
    return booking;
  }

  async confirmPickupByPassenger(bookingId: string, passengerId: string): Promise<Booking> {
    this.logger.log(`Passenger ${passengerId} confirming pickup for booking ${bookingId}`);

    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Réservation non trouvée');
    }

    if (!booking.pickedUp) {
      throw new BadRequestException('Le conducteur doit d\'abord confirmer la prise en charge');
    }

    if (booking.pickedUpConfirmedByPassenger) {
      throw new BadRequestException('La prise en charge est déjà confirmée par le passager');
    }

    booking.pickedUpConfirmedByPassenger = true;
    booking.pickedUpConfirmedAt = new Date();
    await this.bookingRepository.save(booking);

    // Notify driver
    await this.notifyDriverAboutPickupConfirmation(booking);

    // Invalidate cache
    await this.cacheService.del(CacheService.getBookingsByTripKey(booking.tripId));
    await this.cacheService.del(CacheService.getBookingsByPassengerKey(booking.passengerId));

    this.logger.log(`Pickup confirmed by passenger for booking ${bookingId}`);
    return booking;
  }

  async confirmDropoff(bookingId: string, driverId: string): Promise<Booking> {
    this.logger.log(`Driver ${driverId} confirming dropoff for booking ${bookingId}`);

    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Réservation non trouvée');
    }

    if (booking.trip.driverId !== driverId) {
      throw new ForbiddenException('Vous n\'êtes pas le conducteur de ce trajet');
    }

    if (!booking.pickedUp || !booking.pickedUpConfirmedByPassenger) {
      throw new BadRequestException('Le passager doit être pris en charge et confirmé avant la dépose');
    }

    if (booking.droppedOff) {
      throw new BadRequestException('Le passager est déjà marqué comme déposé');
    }

    booking.droppedOff = true;
    booking.droppedOffAt = new Date();
    await this.bookingRepository.save(booking);

    // Notify passenger
    await this.notifyPassengerAboutDropoffConfirmation(booking);

    // Invalidate cache
    await this.cacheService.del(CacheService.getBookingsByTripKey(booking.tripId));
    await this.cacheService.del(CacheService.getBookingsByPassengerKey(booking.passengerId));

    this.logger.log(`Dropoff confirmed for booking ${bookingId}`);
    return booking;
  }

  async confirmDropoffByPassenger(bookingId: string, passengerId: string): Promise<Booking> {
    this.logger.log(`Passenger ${passengerId} confirming dropoff for booking ${bookingId}`);

    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Réservation non trouvée');
    }

    if (!booking.droppedOff) {
      throw new BadRequestException('Le conducteur doit d\'abord confirmer la dépose');
    }

    if (booking.droppedOffConfirmedByPassenger) {
      throw new BadRequestException('La dépose est déjà confirmée par le passager');
    }

    booking.droppedOffConfirmedByPassenger = true;
    booking.droppedOffConfirmedAt = new Date();
    
    // Mark booking as completed
    booking.status = BookingStatus.COMPLETED;
    
    await this.bookingRepository.save(booking);

    // Notify driver
    await this.notifyDriverAboutDropoffConfirmation(booking);

    // Invalidate cache
    await this.cacheService.del(CacheService.getBookingsByTripKey(booking.tripId));
    await this.cacheService.del(CacheService.getBookingsByPassengerKey(booking.passengerId));

    this.logger.log(`Dropoff confirmed by passenger for booking ${bookingId}`);
    return booking;
  }

  async reportBookingProblem(
    bookingId: string,
    userId: string,
    reportDto: ReportBookingProblemDto,
  ): Promise<any> {
    this.logger.log(`User ${userId} reporting problem for booking ${bookingId}`);

    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Réservation non trouvée');
    }

    // Verify user is either driver or passenger
    const isDriver = booking.trip.driverId === userId;
    const isPassenger = booking.passengerId === userId;

    if (!isDriver && !isPassenger) {
      throw new ForbiddenException('Vous n\'êtes pas autorisé à signaler des problèmes pour cette réservation');
    }

    // Determine reported user (opposite party)
    const reportedUserId = isDriver ? booking.passengerId : booking.trip.driverId;

    // Create report using SafetyService
    const report = await this.safetyService.createUserReport(userId, {
      reportedUserId,
      reason: reportDto.reason,
      description: reportDto.description,
      tripId: booking.tripId,
      bookingId: booking.id,
    });

    this.logger.log(`Problem reported for booking ${bookingId} by user ${userId}`);
    return report;
  }

  private async notifyPassengerAboutPickupConfirmation(booking: Booking): Promise<void> {
    try {
      const passenger = await this.userRepository.findOne({
        where: { id: booking.passengerId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!passenger?.fcmToken) {
        this.logger.debug(`Passenger ${booking.passengerId} has no FCM token, skipping notification`);
        return;
      }

      await this.notificationService.sendNotification(
        passenger.fcmToken,
        '✅ Récupération confirmée',
        `Le conducteur a confirmé votre récupération pour le trajet ${booking.trip.departureLocation} → ${booking.passengerDestination || booking.trip.arrivalLocation}. Veuillez confirmer également.`,
        {
          type: 'pickup_confirmed_by_driver',
          bookingId: booking.id,
          tripId: booking.tripId,
        },
        booking.passengerId,
      );
    } catch (error) {
      this.logger.error(`Failed to notify passenger about pickup: ${error.message}`, error.stack);
    }
  }

  private async notifyDriverAboutPickupConfirmation(booking: Booking): Promise<void> {
    try {
      const driver = await this.userRepository.findOne({
        where: { id: booking.trip.driverId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!driver?.fcmToken) {
        this.logger.debug(`Driver ${booking.trip.driverId} has no FCM token, skipping notification`);
        return;
      }

      const passenger = await this.userRepository.findOne({
        where: { id: booking.passengerId },
        select: ['firstName', 'lastName'],
      });
      const passengerName = passenger ? `${passenger.firstName} ${passenger.lastName}` : 'Le passager';

      await this.notificationService.sendNotification(
        driver.fcmToken,
        '✅ Récupération confirmée',
        `${passengerName} a confirmé la récupération pour le trajet ${booking.trip.departureLocation} → ${booking.passengerDestination || booking.trip.arrivalLocation}.`,
        {
          type: 'pickup_confirmed_by_passenger',
          bookingId: booking.id,
          tripId: booking.tripId,
          role: 'driver',
        },
        booking.trip.driverId,
      );
    } catch (error) {
      this.logger.error(`Failed to notify driver about pickup confirmation: ${error.message}`, error.stack);
    }
  }

  private async notifyPassengerAboutDropoffConfirmation(booking: Booking): Promise<void> {
    try {
      const passenger = await this.userRepository.findOne({
        where: { id: booking.passengerId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!passenger?.fcmToken) {
        this.logger.debug(`Passenger ${booking.passengerId} has no FCM token, skipping notification`);
        return;
      }

      await this.notificationService.sendNotification(
        passenger.fcmToken,
        '✅ Dépose confirmée',
        `Le conducteur a confirmé votre dépose pour le trajet ${booking.trip.departureLocation} → ${booking.passengerDestination || booking.trip.arrivalLocation}. Veuillez confirmer également.`,
        {
          type: 'dropoff_confirmed_by_driver',
          bookingId: booking.id,
          tripId: booking.tripId,
        },
        booking.passengerId,
      );
    } catch (error) {
      this.logger.error(`Failed to notify passenger about dropoff: ${error.message}`, error.stack);
    }
  }

  private async notifyDriverAboutDropoffConfirmation(booking: Booking): Promise<void> {
    try {
      const driver = await this.userRepository.findOne({
        where: { id: booking.trip.driverId },
        select: ['id', 'fcmToken', 'firstName'],
      });

      if (!driver?.fcmToken) {
        this.logger.debug(`Driver ${booking.trip.driverId} has no FCM token, skipping notification`);
        return;
      }

      const passenger = await this.userRepository.findOne({
        where: { id: booking.passengerId },
        select: ['firstName', 'lastName'],
      });
      const passengerName = passenger ? `${passenger.firstName} ${passenger.lastName}` : 'Le passager';

      await this.notificationService.sendNotification(
        driver.fcmToken,
        '✅ Dépose confirmée',
        `${passengerName} a confirmé la dépose pour le trajet ${booking.trip.departureLocation} → ${booking.passengerDestination || booking.trip.arrivalLocation}. La réservation est maintenant complétée.`,
        {
          type: 'dropoff_confirmed_by_passenger',
          bookingId: booking.id,
          tripId: booking.tripId,
          role: 'driver',
        },
        booking.trip.driverId,
      );
    } catch (error) {
      this.logger.error(`Failed to notify driver about dropoff confirmation: ${error.message}`, error.stack);
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

  async updatePassengerLocation(
    passengerId: string,
    bookingId: string,
    updateLocationDto: UpdatePassengerLocationDto,
  ): Promise<{ bookingId: string; coordinates: [number, number]; updatedAt: Date }> {
    this.logger.log(`Updating passenger location for booking ${bookingId} by passenger ${passengerId}`);

    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
      relations: ['trip'],
    });

    if (!booking) {
      throw new NotFoundException('Réservation non trouvée ou vous n\'êtes pas le passager');
    }

    // Vérifier que la réservation est acceptée
    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException('Seules les réservations acceptées peuvent partager leur position');
    }

    // Vérifier que le trajet est actif
    if (booking.trip.status !== TripStatus.ACTIVE) {
      throw new BadRequestException('Le trajet doit être actif pour partager la position');
    }

    // Construire le point de position
    const currentLocation: Point = {
      type: 'Point',
      coordinates: [
        Number(updateLocationDto.longitude),
        Number(updateLocationDto.latitude),
      ],
    };

    // Mettre à jour la position
    booking.passengerCurrentLocation = currentLocation;
    booking.passengerLastLocationUpdateAt = new Date();
    await this.bookingRepository.save(booking);

    this.logger.log(`Passenger location updated for booking ${bookingId}`);

    // Vérifier la proximité de la destination et notifier si nécessaire
    await this.checkAndNotifyDestinationProximity(booking);

    return {
      bookingId: booking.id,
      coordinates: [updateLocationDto.longitude, updateLocationDto.latitude],
      updatedAt: booking.passengerLastLocationUpdateAt!,
    };
  }

  /**
   * Calcule la distance en mètres entre la position actuelle du passager et sa destination
   */
  private async calculateDistanceToDestination(booking: Booking): Promise<number | null> {
    if (!booking.passengerCurrentLocation || !booking.passengerDestinationPoint) {
      return null;
    }

    try {
      // Utiliser PostGIS ST_Distance pour calculer la distance en mètres
      const result = await this.bookingRepository
        .createQueryBuilder('booking')
        .select(
          `ST_Distance(
            booking.passengerCurrentLocation::geography,
            booking.passengerDestinationPoint::geography
          )`,
          'distance',
        )
        .where('booking.id = :id', { id: booking.id })
        .getRawOne();

      return result?.distance ? Math.round(result.distance) : null;
    } catch (error) {
      this.logger.error(`Error calculating distance to destination: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Vérifie si le passager est proche de sa destination et envoie les notifications si nécessaire
   */
  private async checkAndNotifyDestinationProximity(booking: Booking): Promise<void> {
    // Ne pas vérifier si la notification a déjà été envoyée
    if (booking.destinationProximityNotified) {
      return;
    }

    // Vérifier que la destination est définie
    if (!booking.passengerDestinationPoint) {
      return;
    }

    // Calculer la distance
    const distance = await this.calculateDistanceToDestination(booking);
    
    if (distance === null || distance > this.DESTINATION_PROXIMITY_THRESHOLD_METERS) {
      return;
    }

    this.logger.log(
      `Passenger ${booking.passengerId} is ${distance}m away from destination for booking ${booking.id}. Sending notifications.`,
    );

    // Marquer comme notifié et envoyer les notifications
    booking.destinationProximityNotified = true;
    await this.bookingRepository.save(booking);

    // Envoyer les notifications au conducteur et au passager
    await this.notifyDestinationProximity(booking, distance);
  }

  /**
   * Envoie les notifications de proximité au conducteur et au passager
   */
  private async notifyDestinationProximity(booking: Booking, distanceMeters: number): Promise<void> {
    try {
      // Charger les relations nécessaires
      const bookingWithRelations = await this.bookingRepository.findOne({
        where: { id: booking.id },
        relations: ['passenger', 'trip', 'trip.driver'],
      });

      if (!bookingWithRelations || !bookingWithRelations.trip || !bookingWithRelations.passenger) {
        this.logger.warn(`Cannot notify destination proximity: missing relations for booking ${booking.id}`);
        return;
      }

      const trip = bookingWithRelations.trip;
      const passenger = bookingWithRelations.passenger;
      const driver = trip.driver;

      const distanceKm = (distanceMeters / 1000).toFixed(1);
      const destinationName = bookingWithRelations.passengerDestination || 'votre destination';

      // Notification au passager
      if (passenger.fcmToken) {
        const passengerTitle = '📍 Proche de votre destination';
        const passengerBody = `Vous êtes à environ ${distanceKm} km de ${destinationName}. Préparez-vous à descendre.`;

        const passengerData = {
          type: 'destination_proximity',
          bookingId: booking.id,
          tripId: trip.id,
          distanceMeters,
          distanceKm: parseFloat(distanceKm),
          destination: destinationName,
        };

        await this.notificationService.sendNotification(
          passenger.fcmToken,
          passengerTitle,
          passengerBody,
          passengerData,
          passenger.id,
        );
        this.logger.log(`Notified passenger ${passenger.id} about destination proximity`);
      }

      // Notification au conducteur
      if (driver && driver.fcmToken) {
        const driverTitle = '📍 Passager proche de sa destination';
        const driverBody = `${passenger.firstName} ${passenger.lastName} est à environ ${distanceKm} km de ${destinationName}. Préparez-vous à l'arrêt.`;

        const driverData = {
          type: 'passenger_destination_proximity',
          bookingId: booking.id,
          tripId: trip.id,
          passengerId: passenger.id,
          passengerName: `${passenger.firstName} ${passenger.lastName}`,
          distanceMeters,
          distanceKm: parseFloat(distanceKm),
          destination: destinationName,
        };

        await this.notificationService.sendNotification(
          driver.fcmToken,
          driverTitle,
          driverBody,
          driverData,
          driver.id,
        );
        this.logger.log(`Notified driver ${driver.id} about passenger destination proximity`);
      }
    } catch (error) {
      this.logger.error(
        `Error notifying destination proximity for booking ${booking.id}: ${error.message}`,
        error.stack,
      );
    }
  }

  async getPassengersLocations(tripId: string, driverId: string): Promise<Array<{
    bookingId: string;
    passengerId: string;
    passengerName: string;
    coordinates: [number, number] | null;
    lastLocationUpdateAt: Date | null;
  }>> {
    this.logger.log(`Getting passengers locations for trip ${tripId} by driver ${driverId}`);

    // Vérifier que l'utilisateur est le conducteur du trajet
    const trip = await this.tripRepository.findOne({
      where: { id: tripId, driverId },
    });

    if (!trip) {
      throw new NotFoundException('Trajet non trouvé ou vous n\'êtes pas le conducteur');
    }

    // Récupérer toutes les réservations acceptées pour ce trajet
    const acceptedBookings = await this.bookingRepository.find({
      where: {
        tripId,
        status: BookingStatus.ACCEPTED,
      },
      relations: ['passenger'],
      select: ['id', 'passengerId', 'passengerCurrentLocation', 'passengerLastLocationUpdateAt'],
    });

    // Convertir les positions en coordonnées
    return acceptedBookings.map((booking) => {
      let coordinates: [number, number] | null = null;
      
      if (booking.passengerCurrentLocation) {
        const point = booking.passengerCurrentLocation as any;
        if (point.coordinates && point.coordinates.length === 2) {
          coordinates = [point.coordinates[0], point.coordinates[1]]; // [longitude, latitude]
        }
      }

      return {
        bookingId: booking.id,
        passengerId: booking.passengerId,
        passengerName: booking.passenger 
          ? `${booking.passenger.firstName} ${booking.passenger.lastName}`
          : 'Passager inconnu',
        coordinates,
        lastLocationUpdateAt: booking.passengerLastLocationUpdateAt,
      };
    });
  }
}

