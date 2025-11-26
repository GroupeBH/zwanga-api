import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, MoreThan } from 'typeorm';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { NotificationService } from './notifications.service';

interface PreferredLocations {
  departures: string[];
  arrivals: string[];
}

@Injectable()
export class TripAvailabilityNotificationService {
  private readonly logger = new Logger(
    TripAvailabilityNotificationService.name,
  );

  private readonly MAX_RECENT_BOOKINGS = 10;
  private readonly MAX_LOCATIONS = 3;
  private readonly MAX_TRIPS_PER_USER = 3;

  constructor(
    @InjectRepository(Trip)
    private readonly tripRepository: Repository<Trip>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly notificationService: NotificationService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sendRecommendationNotifications() {
    this.logger.debug('Running trip availability recommendation cron job');

    const users = await this.userRepository.find({
      where: { isActive: true },
      select: ['id', 'firstName', 'fcmToken'],
    });

    for (const user of users) {
      if (!user.fcmToken) {
        continue;
      }

      const preferences = await this.getPreferredLocations(user.id);

      if (
        preferences.departures.length === 0 ||
        preferences.arrivals.length === 0
      ) {
        continue;
      }

      const matchingTrips = await this.findMatchingTrips(preferences);

      if (matchingTrips.length === 0) {
        continue;
      }

      await this.notifyUserAboutTrips(user, matchingTrips);
    }
  }

  private async getPreferredLocations(
    userId: string,
  ): Promise<PreferredLocations> {
    const bookings = await this.bookingRepository.find({
      where: {
        passengerId: userId,
        status: In([BookingStatus.ACCEPTED, BookingStatus.COMPLETED]),
      },
      relations: ['trip'],
      order: { createdAt: 'DESC' },
      take: this.MAX_RECENT_BOOKINGS,
    });

    const departureCounts = new Map<string, number>();
    const arrivalCounts = new Map<string, number>();

    for (const booking of bookings) {
      if (!booking.trip) continue;

      const dep = booking.trip.departureLocation;
      const arr = booking.trip.arrivalLocation;

      departureCounts.set(dep, (departureCounts.get(dep) || 0) + 1);
      arrivalCounts.set(arr, (arrivalCounts.get(arr) || 0) + 1);
    }

    return {
      departures: this.pickTopKeys(departureCounts, this.MAX_LOCATIONS),
      arrivals: this.pickTopKeys(arrivalCounts, this.MAX_LOCATIONS),
    };
  }

  private pickTopKeys(map: Map<string, number>, limit: number): string[] {
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key]) => key);
  }

  private async findMatchingTrips(preferences: PreferredLocations) {
    if (
      preferences.departures.length === 0 ||
      preferences.arrivals.length === 0
    ) {
      return [];
    }

    const now = new Date();

    const trips = await this.tripRepository.find({
      where: {
        status: TripStatus.PENDING,
        departureDate: MoreThan(now),
        departureLocation: In(preferences.departures),
        arrivalLocation: In(preferences.arrivals),
      },
      relations: ['bookings', 'driver'],
      order: { departureDate: 'ASC' },
      take: 10,
    });

    return trips
      .filter((trip) => this.hasAvailableSeats(trip))
      .slice(0, this.MAX_TRIPS_PER_USER);
  }

  private hasAvailableSeats(trip: Trip): boolean {
    const acceptedSeats =
      trip.bookings
        ?.filter((booking) => booking.status === BookingStatus.ACCEPTED)
        .reduce((total, booking) => total + booking.numberOfSeats, 0) ?? 0;

    return trip.availableSeats - acceptedSeats > 0;
  }

  private async notifyUserAboutTrips(user: User, trips: Trip[]) {
    if (trips.length === 0) {
      return;
    }

    const lines = trips.map((trip) => {
      const date = new Date(trip.departureDate);
      return `${trip.departureLocation} → ${trip.arrivalLocation} (${date.toLocaleString()})`;
    });

    const title = 'Nouveaux trajets disponibles';
    const body = `Des places se libèrent sur vos trajets habituels :\n${lines.join(
      '\n',
    )}`;

    try {
      await this.notificationService.sendNotification(
        user.fcmToken!,
        title,
        body,
        {
          tripId: trips[0].id,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Failed to send recommendation notification to user ${user.id}: ${error.message}`,
      );
    }
  }
}

