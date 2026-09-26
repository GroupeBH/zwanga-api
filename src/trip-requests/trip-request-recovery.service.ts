import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { FindOptionsWhere } from 'typeorm';
import { NotificationService } from '../notifications/notifications.service';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { DriverOffer, DriverOfferStatus } from './entities/driver-offer.entity';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';

@Injectable()
export class TripRequestRecoveryService {
  private readonly logger = new Logger(TripRequestRecoveryService.name);

  constructor(
    @InjectRepository(TripRequest)
    private readonly tripRequestRepository: Repository<TripRequest>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * Reopens the request only when the owning passenger explicitly releases
   * the overdue selected driver. The conditional update keeps retries and
   * concurrent taps idempotent.
   */
  async reopenAfterPassengerReleasesOverdueDriver(
    tripRequestId: string,
    passengerId: string,
  ): Promise<TripRequest | null> {
    return this.reopenMatchingSelection({
      id: tripRequestId,
      passengerId,
      status: TripRequestStatus.DRIVER_SELECTED,
    });
  }

  private async reopenMatchingSelection(
    where: FindOptionsWhere<TripRequest>,
  ): Promise<TripRequest | null> {
    const reopened = await this.tripRequestRepository.manager.transaction(
      async (manager) => {
        const request = await manager.findOne(TripRequest, {
          where,
        });

        if (!request?.selectedDriverId) {
          return null;
        }

        const updateResult = await manager.update(
          TripRequest,
          {
            id: request.id,
            tripId: request.tripId ?? IsNull(),
            selectedDriverId: request.selectedDriverId,
            status: TripRequestStatus.DRIVER_SELECTED,
          },
          {
            status: TripRequestStatus.PENDING,
            selectedDriverId: null,
            selectedVehicleId: null,
            selectedPricePerSeat: null,
            selectedDriverRequiresPassengerKyc: false,
            selectedAt: null,
            tripId: null,
            expirationNotificationSent: false,
            driverPickupOverdueNotifiedAt: null,
          },
        );

        if (updateResult.affected !== 1) {
          return null;
        }

        await manager.update(
          DriverOffer,
          {
            tripRequestId: request.id,
            driverId: request.selectedDriverId,
            status: DriverOfferStatus.ACCEPTED,
          },
          { status: DriverOfferStatus.CANCELLED },
        );

        if (request.tripId) {
          const linkedTrip = await manager.findOne(Trip, {
            where: { id: request.tripId, tripRequestId: request.id },
          });
          if (linkedTrip) {
            await manager.update(
              Trip,
              { id: linkedTrip.id, tripRequestId: request.id },
              {
                tripRequestId: null,
                ...(linkedTrip.isPrivate &&
                linkedTrip.status !== TripStatus.COMPLETED
                  ? { status: TripStatus.CANCELLED }
                  : {}),
              },
            );
          }
        }

        return manager.findOne(TripRequest, {
          where: { id: request.id },
        });
      },
    );

    if (!reopened) {
      return null;
    }

    this.logger.log(
      `Trip request ${reopened.id} reopened after its passenger released the overdue driver`,
    );
    await this.notifyReopenedRequest(reopened);
    return reopened;
  }

  private async notifyReopenedRequest(tripRequest: TripRequest): Promise<void> {
    try {
      await this.notificationService.sendNotificationToUser(
        tripRequest.passengerId,
        'Votre demande est de nouveau disponible',
        'Le conducteur ne peut plus effectuer ce trajet. Votre demande est de nouveau visible par les conducteurs.',
        {
          type: 'trip_request_reopened',
          tripRequestId: tripRequest.id,
          reason: 'passenger_released_overdue_driver',
        },
      );

      const drivers = await this.userRepository.find({
        where: { role: UserRole.DRIVER, isActive: true },
        select: ['id', 'fcmToken'],
      });
      const driversWithTokens = drivers.filter(
        (driver) =>
          Boolean(driver.fcmToken?.trim()) &&
          driver.id !== tripRequest.passengerId,
      );

      if (driversWithTokens.length === 0) {
        return;
      }

      await this.notificationService.sendToMultiple(
        driversWithTokens.map((driver) => driver.fcmToken!.trim()),
        'Demande de trajet à nouveau disponible',
        'Un passager cherche un trajet. Consultez la demande pour voir les points de départ et d’arrivée.',
        {
          type: 'trip_request',
          tripRequestId: tripRequest.id,
          departureLocation: 'Point de départ',
          arrivalLocation: 'Point d’arrivée',
          numberOfSeats: String(tripRequest.numberOfSeats),
          vehicleType: tripRequest.vehicleType,
          maxPricePerSeat: String(Number(tripRequest.maxPricePerSeat ?? 0)),
          departureDateMin: tripRequest.departureDateMin.toISOString(),
          departureDateMax: tripRequest.departureDateMax.toISOString(),
        },
        driversWithTokens.map((driver) => driver.id),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Unable to notify users about reopened trip request ${tripRequest.id}: ${message}`,
        stack,
      );
    }
  }
}
