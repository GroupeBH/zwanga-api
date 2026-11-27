import { DataSource, In } from 'typeorm';
import type { Socket } from 'socket.io';
import { Trip, TripStatus } from '../../trips/entities/trip.entity';
import { BookingStatus } from '../../bookings/entities/booking.entity';

// Live GPS uses a stricter policy than access to an archived conversation.
export async function pruneTrackingRooms(dataSource: DataSource, sockets: Socket[]) {
  // Joining a room is separately authorized. Rooms joined during this read are
  // absent from its SQL result and must be checked by the next sweep instead.
  const checked = sockets.map(socket => ({ socket, viewer: socket.data.userId,
    rooms: [...(socket.rooms ?? [])].filter(room => room.startsWith('trip:')) }));
  const ids = new Set<string>();
  for (const { rooms } of checked) for (const room of rooms) {
    ids.add(room.slice(5));
  }
  if (!ids.size) return;
  const trips = await dataSource.getRepository(Trip).find({ where: { id: In([...ids]), status: TripStatus.ACTIVE },
    select: { id: true, driverId: true, bookings: { passengerId: true, status: true } }, relations: ['bookings'] });
  const byId = new Map(trips.map(trip => [trip.id, trip]));
  for (const { socket, rooms, viewer } of checked) for (const room of rooms) {
    if (socket.data.userId !== viewer || !socket.rooms?.has(room)) continue;
    const trip = byId.get(room.slice(5));
    if (!trip || (trip.driverId !== viewer && !trip.bookings.some(booking =>
      booking.passengerId === viewer && booking.status === BookingStatus.ACCEPTED))) await socket.leave(room);
  }
}
