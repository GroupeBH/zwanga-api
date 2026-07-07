import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Point, Repository } from 'typeorm';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { CreateTripShareLinkDto } from './dto/trip-share.dto';
import { TripShareLink } from './entities/trip-share-link.entity';

type PublicCoordinate = {
  latitude: number;
  longitude: number;
};

type PublicTrackingLocation = {
  name: string;
  reference: string | null;
  coordinates: PublicCoordinate | null;
};

@Injectable()
export class TrackingService {
  private readonly DEFAULT_SHARE_EXPIRY_HOURS = 48;

  constructor(
    @InjectRepository(TripShareLink)
    private readonly tripShareLinkRepository: Repository<TripShareLink>,
    @InjectRepository(Trip)
    private readonly tripRepository: Repository<Trip>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    private readonly configService: ConfigService,
  ) {}

  async createTripShareLink(
    userId: string,
    tripId: string,
    dto: CreateTripShareLinkDto,
  ) {
    const trip = await this.tripRepository.findOne({
      where: { id: tripId },
      relations: ['driver', 'vehicle'],
    });

    if (!trip) {
      throw new NotFoundException('Trajet non trouve');
    }

    const booking = await this.resolveShareBooking(trip, userId, dto.bookingId);
    const expiresInHours =
      dto.expiresInHours ?? this.DEFAULT_SHARE_EXPIRY_HOURS;
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
    const token = await this.generateUniqueToken();

    const shareLink = await this.tripShareLinkRepository.save(
      this.tripShareLinkRepository.create({
        token,
        tripId: trip.id,
        bookingId: booking?.id ?? null,
        ownerId: userId,
        recipientEmail: dto.recipientEmail?.trim() || null,
        recipientName: dto.recipientName?.trim() || null,
        message: dto.message?.trim() || null,
        expiresAt,
        revokedAt: null,
        lastAccessedAt: null,
      }),
    );

    const publicUrl = this.buildPublicTrackingUrl(shareLink.token);
    const email = this.buildShareEmail({
      recipientEmail: shareLink.recipientEmail,
      recipientName: shareLink.recipientName,
      customMessage: shareLink.message,
      publicUrl,
      trip,
      expiresAt,
    });

    return {
      id: shareLink.id,
      token: shareLink.token,
      tripId: shareLink.tripId,
      bookingId: shareLink.bookingId,
      publicUrl,
      expiresAt: shareLink.expiresAt,
      email,
    };
  }

  async getPublicTripTracking(token: string) {
    const shareLink = await this.tripShareLinkRepository.findOne({
      where: { token },
      relations: [
        'trip',
        'trip.driver',
        'trip.vehicle',
        'booking',
        'booking.passenger',
      ],
    });

    if (!shareLink) {
      throw new NotFoundException('Lien de suivi introuvable');
    }

    if (shareLink.revokedAt) {
      throw new GoneException('Ce lien de suivi a ete revoque');
    }

    if (shareLink.expiresAt.getTime() <= Date.now()) {
      throw new GoneException('Ce lien de suivi a expire');
    }

    const { trip, booking } = shareLink;
    if (!trip) {
      throw new NotFoundException('Trajet introuvable');
    }

    await this.tripShareLinkRepository.update(shareLink.id, {
      lastAccessedAt: new Date(),
    });

    return {
      share: {
        token: shareLink.token,
        expiresAt: shareLink.expiresAt,
        recipientName: shareLink.recipientName,
      },
      trip: {
        id: trip.id,
        status: trip.status,
        departureDate: trip.departureDate,
        startedAt: trip.startedAt,
        estimatedArrivalDate: trip.estimatedArrivalDate,
        completedAt: trip.completedAt,
        currentLocation: this.pointToPublicCoordinate(trip.currentLocation),
        lastLocationUpdateAt: trip.lastLocationUpdateAt,
        route: {
          departure: this.buildTripLocation(
            trip.departureLocation,
            trip.departureReference,
            trip.departurePoint,
          ),
          arrival: this.buildTripLocation(
            trip.arrivalLocation,
            trip.arrivalReference,
            trip.arrivalPoint,
          ),
        },
        driver: {
          name: this.buildPersonName(
            trip.driver?.firstName,
            trip.driver?.lastName,
            'Conducteur',
          ),
          profilePicture: trip.driver?.profilePicture ?? null,
        },
        vehicle: trip.vehicle
          ? {
              brand: trip.vehicle.brand,
              model: trip.vehicle.model,
              color: trip.vehicle.color,
              licensePlate: trip.vehicle.licensePlate,
            }
          : null,
      },
      booking: booking
        ? {
            id: booking.id,
            status: booking.status,
            pickedUp: booking.pickedUp,
            pickedUpAt: booking.pickedUpAt,
            pickedUpConfirmedByPassenger:
              booking.pickedUpConfirmedByPassenger,
            droppedOff: booking.droppedOff,
            droppedOffAt: booking.droppedOffAt,
            droppedOffConfirmedByPassenger:
              booking.droppedOffConfirmedByPassenger,
            passenger: {
              name: this.buildPersonName(
                booking.passenger?.firstName,
                booking.passenger?.lastName,
                'Passager',
              ),
            },
            origin: this.buildTripLocation(
              booking.passengerOrigin || trip.departureLocation,
              booking.passengerOriginReference || trip.departureReference,
              booking.passengerOriginPoint || trip.departurePoint,
            ),
            destination: this.buildTripLocation(
              booking.passengerDestination || trip.arrivalLocation,
              booking.passengerDestinationReference || trip.arrivalReference,
              booking.passengerDestinationPoint || trip.arrivalPoint,
            ),
          }
        : null,
      freshness: {
        isLive: trip.status === TripStatus.ACTIVE,
        polledAt: new Date(),
      },
    };
  }

  private async resolveShareBooking(
    trip: Trip,
    userId: string,
    requestedBookingId?: string,
  ): Promise<Booking | null> {
    const isDriver = trip.driverId === userId;

    if (isDriver) {
      if (requestedBookingId) {
        throw new BadRequestException(
          'Le conducteur peut partager le suivi global du trajet, pas une reservation passager',
        );
      }
      return null;
    }

    const booking = requestedBookingId
      ? await this.bookingRepository.findOne({
          where: { id: requestedBookingId, tripId: trip.id },
          relations: ['passenger'],
        })
      : await this.bookingRepository.findOne({
          where: {
            tripId: trip.id,
            passengerId: userId,
            status: BookingStatus.ACCEPTED,
          },
          relations: ['passenger'],
        });

    if (requestedBookingId && !booking) {
      throw new NotFoundException('Reservation introuvable pour ce trajet');
    }

    if (!booking) {
      throw new ForbiddenException(
        'Vous devez etre conducteur du trajet ou avoir une reservation acceptee pour partager ce suivi',
      );
    }

    if (!isDriver && booking.passengerId !== userId) {
      throw new ForbiddenException(
        'Vous ne pouvez partager que votre propre reservation',
      );
    }

    if (
      booking.status !== BookingStatus.ACCEPTED &&
      booking.status !== BookingStatus.COMPLETED
    ) {
      throw new BadRequestException(
        'Le suivi public est disponible uniquement pour une reservation acceptee',
      );
    }

    return booking;
  }

  private buildPublicTrackingUrl(token: string): string {
    const configuredBaseUrl =
      this.configService.get<string>('TRACKING_PUBLIC_BASE_URL')?.trim() ||
      this.configService.get<string>('ZWANGA_PUBLIC_WEB_URL')?.trim() ||
      this.configService.get<string>('FRONTEND_URL')?.trim() ||
      'https://zwanga-app.com';
    const baseUrl = configuredBaseUrl.replace(/\/+$/, '');
    return `${baseUrl}/track/${token}`;
  }

  private buildShareEmail(params: {
    recipientEmail: string | null;
    recipientName: string | null;
    customMessage: string | null;
    publicUrl: string;
    trip: Trip;
    expiresAt: Date;
  }) {
    const subject = `Suivi en temps reel Zwanga: ${params.trip.departureLocation} vers ${params.trip.arrivalLocation}`;
    const greeting = params.recipientName
      ? `Bonjour ${params.recipientName},`
      : 'Bonjour,';
    const body = [
      greeting,
      '',
      params.customMessage || 'Je vous partage mon trajet Zwanga.',
      '',
      `Depart: ${params.trip.departureLocation}`,
      `Arrivee: ${params.trip.arrivalLocation}`,
      `Lien de suivi: ${params.publicUrl}`,
      '',
      `Ce lien expire le ${params.expiresAt.toLocaleString('fr-FR', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Africa/Kinshasa',
      })}.`,
      '',
      "Vous pouvez l'ouvrir depuis un navigateur, sans installer l'application.",
    ].join('\n');

    const mailtoUrl = `mailto:${encodeURIComponent(
      params.recipientEmail ?? '',
    )}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    return {
      recipientEmail: params.recipientEmail,
      subject,
      body,
      mailtoUrl,
    };
  }

  private async generateUniqueToken(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = randomBytes(32).toString('base64url');
      const existing = await this.tripShareLinkRepository.exist({
        where: { token },
      });
      if (!existing) {
        return token;
      }
    }

    throw new BadRequestException('Impossible de generer un lien de suivi');
  }

  private buildTripLocation(
    name: string,
    reference: string | null,
    point?: Point | null,
  ): PublicTrackingLocation {
    return {
      name,
      reference,
      coordinates: this.pointToPublicCoordinate(point),
    };
  }

  private pointToPublicCoordinate(point?: Point | null): PublicCoordinate | null {
    if (!point?.coordinates || point.coordinates.length < 2) {
      return null;
    }

    const [longitudeValue, latitudeValue] = point.coordinates;
    const latitude = Number(latitudeValue);
    const longitude = Number(longitudeValue);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return null;
    }

    return { latitude, longitude };
  }

  private buildPersonName(
    firstName?: string | null,
    lastName?: string | null,
    fallback = 'Utilisateur',
  ): string {
    const name = [firstName, lastName].filter(Boolean).join(' ').trim();
    return name || fallback;
  }
}
