import { DataSource, In } from 'typeorm';
import type { Socket } from 'socket.io';
import { Trip, TripStatus } from '../../trips/entities/trip.entity';
import { BookingStatus } from '../../bookings/entities/booking.entity';

// Live GPS uses a stricter policy than access to an archived conversation.
export async function pruneTrackingRooms(dataSource: DataSource, sockets: Socket[]) {
  const ids = new Set<string>();
  for (const socket of sockets) for (const room of socket.rooms ?? []) {
    if (room.startsWith('trip:')) ids.add(room.slice(5));
  }
  if (!ids.size) return;
  const trips = await dataSource.getRepository(Trip).find({ where: { id: In([...ids]), status: TripStatus.ACTIVE },
    select: { id: true, driverId: true, bookings: { passengerId: true, status: true } }, relations: ['bookings'] });
  const byId = new Map(trips.map(trip => [trip.id, trip]));
  for (const socket of sockets) for (const room of socket.rooms ?? []) {
    if (!room.startsWith('trip:')) continue;
    const trip = byId.get(room.slice(5));
    const viewer = socket.data.userId;
    if (!trip || (trip.driverId !== viewer && !trip.bookings.some(booking =>
      booking.passengerId === viewer && booking.status === BookingStatus.ACCEPTED))) await socket.leave(room);
  }
}
