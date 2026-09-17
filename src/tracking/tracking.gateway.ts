import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WsException,
} from '@nestjs/websockets';
import { Logger, UseFilters, UseGuards, UsePipes } from '@nestjs/common';
import { Namespace, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TripsService } from '../trips/trips.service';
import { BookingsService } from '../bookings/bookings.service';
import { normalizeLngLatCoordinates } from '../common/utils/tracking-coordinates';
import {
  BookingSocketDto,
  DriverLocationSocketDto,
  PassengerLocationSocketDto,
  TripSocketDto,
} from './dto/tracking-socket.dto';
import {
  authenticateSocket,
  createWsValidationPipe,
  emitSocketError,
  WsAuthenticatedGuard,
  WsErrorFilter,
} from '../common/websocket-security';

@WebSocketGateway({
  namespace: '/tracking',
})
@UseGuards(new WsAuthenticatedGuard())
@UsePipes(createWsValidationPipe())
@UseFilters(new WsErrorFilter())
export class TrackingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Namespace;
  private readonly logger = new Logger(TrackingGateway.name);

  constructor(
    private readonly tripsService: TripsService,
    private readonly bookingsService: BookingsService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  private parseCoordinates(coordinates?: [number, number]): [number, number] {
    const normalizedCoordinates = normalizeLngLatCoordinates(coordinates);
    if (!normalizedCoordinates) {
      throw new WsException('Coordonnées invalides');
    }

    return normalizedCoordinates;
  }

  private async evaluateAndEmitAutomaticProgress(
    client: Socket,
    tripId: string,
  ): Promise<void> {
    const autoProgress =
      await this.bookingsService.evaluateAutomaticRideProgressForTrip(tripId);
    if (autoProgress.events.length > 0) {
      client.emit('booking_auto_progress', autoProgress);
    }
  }

  private shouldSampleGpsPosition(): boolean {
    const configuredRate = Number(
      this.configService.get<string>('GPS_LOG_SAMPLE_RATE') ?? '0.01',
    );
    const sampleRate = Number.isFinite(configuredRate)
      ? Math.min(Math.max(configuredRate, 0), 1)
      : 0.01;
    return Math.random() < sampleRate;
  }

  private logGpsSample(
    event: 'driver_location_update' | 'passenger_location_update',
    payload: {
      tripId: string;
      bookingId?: string;
      userId?: string;
      accuracy?: number;
      speed?: number;
      recordedAt?: string;
    },
  ): void {
    if (!this.shouldSampleGpsPosition()) {
      return;
    }

    this.logger.warn(
      JSON.stringify({
        event,
        sampled: true,
        ...payload,
      }),
    );
  }

  private logAutomaticProgress(
    source: 'driver_location_update' | 'passenger_location_update',
    events: Array<{
      type: string;
      tripId: string;
      bookingId?: string;
      passengerId?: string;
      detectedAt?: string;
      decision?: string;
      confidenceScore?: number;
    }>,
  ): void {
    for (const event of events) {
      this.logger.warn(
        JSON.stringify({
          event: 'ride_progress_detection',
          source,
          type: event.type,
          tripId: event.tripId,
          bookingId: event.bookingId,
          passengerId: event.passengerId,
          detectedAt: event.detectedAt,
          decision: event.decision,
          confidenceScore: event.confidenceScore,
        }),
      );
    }
  }

  async handleConnection(client: Socket) {
    try {
      if (
        !(await authenticateSocket(client, this.jwtService, this.configService))
      ) {
        return;
      }
      const tripId =
        typeof client.handshake.auth.tripId === 'string'
          ? client.handshake.auth.tripId
          : typeof client.handshake.query.tripId === 'string'
            ? client.handshake.query.tripId
            : undefined;
      this.logger.warn(
        JSON.stringify({
          event: 'socket_reconnected',
          namespace: '/tracking',
          userId: client.data.userId,
          tripId,
          socketId: client.id,
        }),
      );
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    // no-op
  }

  @SubscribeMessage('join_trip')
  async handleJoinTrip(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TripSocketDto,
  ) {
    try {
      await this.tripsService.ensureUserCanTrackTrip(
        data.tripId,
        client.data.userId,
      );
      await client.join(`trip:${data.tripId}`);
      client.data.tripId = data.tripId;
      await this.evaluateAndEmitAutomaticProgress(client, data.tripId);
    } catch (error) {
      emitSocketError(client, error);
    }
  }

  @SubscribeMessage('leave_trip')
  async handleLeaveTrip(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TripSocketDto,
  ) {
    await client.leave(`trip:${data.tripId}`);
  }

  @SubscribeMessage('driver_location_update')
  async handleDriverLocationUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: DriverLocationSocketDto,
  ) {
    try {
      const coordinates = this.parseCoordinates(data.coordinates);
      const location = await this.tripsService.updateDriverLocation(
        client.data.userId,
        data.tripId,
        coordinates,
        {
          accuracyMeters: data.accuracy,
          speedMetersPerSecond: data.speed,
          headingDegrees: data.heading,
          recordedAt: data.recordedAt,
        },
      );
      const autoProgress =
        await this.bookingsService.evaluateAutomaticRideProgressForTrip(
          data.tripId,
        );

      this.server.to(`trip:${data.tripId}`).emit('driver_location', location);
      if (autoProgress.events.length > 0) {
        this.logAutomaticProgress(
          'driver_location_update',
          autoProgress.events,
        );
        this.server
          .to(`trip:${data.tripId}`)
          .emit('booking_auto_progress', autoProgress);
      }
      this.logGpsSample('driver_location_update', {
        tripId: data.tripId,
        userId: client.data.userId,
        accuracy: data.accuracy,
        speed: data.speed,
        recordedAt: data.recordedAt,
      });
    } catch (error) {
      emitSocketError(client, error);
    }
  }

  @SubscribeMessage('passenger_location_update')
  async handlePassengerLocationUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: PassengerLocationSocketDto,
  ) {
    try {
      const [longitude, latitude] = this.parseCoordinates(data.coordinates);
      const location = await this.bookingsService.updatePassengerLocation(
        client.data.userId,
        data.bookingId,
        {
          latitude: Number(latitude),
          longitude: Number(longitude),
          accuracy: data.accuracy,
          speed: data.speed,
          heading: data.heading,
          recordedAt: data.recordedAt,
        },
      );

      const payload = {
        tripId: location.tripId,
        bookingId: location.bookingId,
        passengerId: client.data.userId,
        coordinates: location.coordinates,
        updatedAt: location.updatedAt,
      };

      this.server
        .to(`trip:${location.tripId}`)
        .emit('passenger_location', payload);
      if (location.autoProgress.events.length > 0) {
        this.logAutomaticProgress(
          'passenger_location_update',
          location.autoProgress.events,
        );
        this.server
          .to(`trip:${location.tripId}`)
          .emit('booking_auto_progress', location.autoProgress);
      }
      this.logGpsSample('passenger_location_update', {
        tripId: location.tripId,
        bookingId: location.bookingId,
        userId: client.data.userId,
        accuracy: data.accuracy,
        speed: data.speed,
        recordedAt: data.recordedAt,
      });
    } catch (error) {
      emitSocketError(client, error);
    }
  }

  @SubscribeMessage('resume_boarding_detection')
  async handleResumeBoardingDetection(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TripSocketDto,
  ) {
    try {
      await this.tripsService.ensureUserCanTrackTrip(
        data.tripId,
        client.data.userId,
      );
      await this.evaluateAndEmitAutomaticProgress(client, data.tripId);
    } catch (error) {
      emitSocketError(client, error);
    }
  }

  @SubscribeMessage('get_passenger_locations')
  async handleGetPassengerLocations(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TripSocketDto,
  ) {
    try {
      const locations = await this.bookingsService.getPassengersLocations(
        data.tripId,
        client.data.userId,
      );

      client.emit('passenger_locations', {
        tripId: data.tripId,
        locations: locations.map((location) => ({
          tripId: data.tripId,
          ...location,
          updatedAt: location.lastLocationUpdateAt,
        })),
      });
    } catch (error) {
      emitSocketError(client, error);
    }
  }

  @SubscribeMessage('passenger_pickup_signal')
  async handlePassengerPickupSignal(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: BookingSocketDto,
  ) {
    try {
      const event = await this.bookingsService.buildPassengerPickupSignal(
        client.data.userId,
        data.bookingId,
      );

      this.server.to(`trip:${event.tripId}`).emit('booking_auto_progress', {
        tripId: event.tripId,
        events: [event],
      });
    } catch (error) {
      emitSocketError(client, error);
    }
  }

  @SubscribeMessage('get_driver_location')
  async handleGetDriverLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TripSocketDto,
  ) {
    try {
      const location = await this.tripsService.getDriverLocationForUser(
        data.tripId,
        client.data.userId,
      );

      client.emit('driver_location', location);
    } catch (error) {
      emitSocketError(client, error);
    }
  }
}
