import { pruneTrackingRooms } from './ws-tracking-rooms';
import { BookingStatus } from '../../bookings/entities/booking.entity';

describe('Live GPS room authorization', () => {
  it('removes cancelled participants and ended trips while preserving an accepted rider and driver', async () => {
    const createSocket = (userId: string) => ({ data: { userId }, rooms: new Set(['trip:active', 'trip:ended']), leave: jest.fn() });
    const sockets = ['driver', 'accepted', 'cancelled'].map(createSocket);
    const find = jest.fn().mockResolvedValue([{ id: 'active', driverId: 'driver', bookings: [
      { passengerId: 'accepted', status: BookingStatus.ACCEPTED }, { passengerId: 'cancelled', status: BookingStatus.CANCELLED },
    ] }]);
    await pruneTrackingRooms({ getRepository: () => ({ find }) } as any, sockets as any);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0].where.status).toBe('ongoing');
    for (const socket of sockets) expect(socket.leave).toHaveBeenCalledWith('trip:ended');
    expect(sockets[0].leave).not.toHaveBeenCalledWith('trip:active');
    expect(sockets[1].leave).not.toHaveBeenCalledWith('trip:active');
    expect(sockets[2].leave).toHaveBeenCalledWith('trip:active');
  });

  it('does not prune rooms joined during the query, including on a previously empty socket', async () => {
    const existing = { data: { userId: 'driver' }, rooms: new Set(['trip:active']), leave: jest.fn() };
    const newcomer = { data: { userId: 'driver' }, rooms: new Set<string>(), leave: jest.fn() };
    const trip = { id: 'active', driverId: 'driver', bookings: [] };
    const find = jest.fn().mockImplementationOnce(async () => {
      existing.rooms.add('trip:new'); newcomer.rooms.add('trip:new');
      return [trip];
    });
    const source = { getRepository: () => ({ find }) } as any;
    await pruneTrackingRooms(source, [existing, newcomer] as any);
    expect(existing.leave).not.toHaveBeenCalled();
    expect(newcomer.leave).not.toHaveBeenCalled();
    // New rooms are checked next time, not permanently exempted from authorization.
    find.mockResolvedValue([trip]);
    await pruneTrackingRooms(source, [existing, newcomer] as any);
    expect(existing.leave).toHaveBeenCalledWith('trip:new');
    expect(newcomer.leave).toHaveBeenCalledWith('trip:new');
  });

  it('does not act on rooms belonging to a replaced identity during the query', async () => {
    const socket = { data: { userId: 'before' }, rooms: new Set(['trip:active']), leave: jest.fn() };
    const find = jest.fn().mockImplementation(async () => {
      socket.data.userId = 'after';
      return [];
    });
    await pruneTrackingRooms({ getRepository: () => ({ find }) } as any, [socket] as any);
    expect(socket.leave).not.toHaveBeenCalled();
    await pruneTrackingRooms({ getRepository: () => ({ find }) } as any, [socket] as any);
    expect(socket.leave).toHaveBeenCalledWith('trip:active');
  });

  it('propagates a failed membership read to the fail-closed session checker', async () => {
    const socket = { data: { userId: 'driver' }, rooms: new Set(['trip:active']), leave: jest.fn() };
    await expect(pruneTrackingRooms({ getRepository: () => ({ find: jest.fn().mockRejectedValue(new Error('offline')) }) } as any,
      [socket] as any)).rejects.toThrow('offline');
  });
});
