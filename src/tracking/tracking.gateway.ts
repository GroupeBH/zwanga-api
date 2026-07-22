import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TripsService } from '../trips/trips.service';
import { BookingsService } from '../bookings/bookings.service';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/tracking',
})
export class TrackingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly tripsService: TripsService,
    private readonly bookingsService: BookingsService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  private parseCoordinates(coordinates?: [number, number]): [number, number] {
    if (!Array.isArray(coordinates) || coordinates.length !== 2) {
      throw new Error('Coordonnees invalides');
    }

    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);

    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      throw new Error('Coordonnees invalides');
    }

    return [longitude, latitude];
  }

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth.token ||
        client.handshake.headers.authorization?.split(' ')[1];

      if (!token) {
        client.disconnect();
        return;
      }

      const payload = await this.jwtService.verifyAsync(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      client.data.userId = payload.sub;
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
    @MessageBody() data: { tripId: string },
  ) {
    try {
      await this.tripsService.ensureUserCanTrackTrip(
        data.tripId,
        client.data.userId,
      );
      client.join(`trip:${data.tripId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('leave_trip')
  async handleLeaveTrip(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tripId: string },
  ) {
    client.leave(`trip:${data.tripId}`);
  }

  @SubscribeMessage('driver_location_update')
  async handleDriverLocationUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { tripId: string; coordinates: [number, number] },
  ) {
    try {
      const coordinates = this.parseCoordinates(data.coordinates);
      const location = await this.tripsService.updateDriverLocation(
        client.data.userId,
        data.tripId,
        coordinates,
      );
      const autoProgress =
        await this.bookingsService.evaluateAutomaticRideProgressForTrip(
          data.tripId,
        );

      this.server.to(`trip:${data.tripId}`).emit('driver_location', location);
      if (autoProgress.events.length > 0) {
        this.server
          .to(`trip:${data.tripId}`)
          .emit('booking_auto_progress', autoProgress);
      }
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('passenger_location_update')
  async handlePassengerLocationUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { tripId: string; bookingId: string; coordinates: [number, number] },
  ) {
    try {
      const [longitude, latitude] = this.parseCoordinates(data.coordinates);
      const location = await this.bookingsService.updatePassengerLocation(
        client.data.userId,
        data.bookingId,
        {
          latitude: Number(latitude),
          longitude: Number(longitude),
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
        this.server
          .to(`trip:${location.tripId}`)
          .emit('booking_auto_progress', location.autoProgress);
      }
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('get_passenger_locations')
  async handleGetPassengerLocations(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tripId: string },
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
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('get_driver_location')
  async handleGetDriverLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tripId: string },
  ) {
    try {
      const location = await this.tripsService.getDriverLocationForUser(
        data.tripId,
        client.data.userId,
      );

      client.emit('driver_location', location);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }
}
