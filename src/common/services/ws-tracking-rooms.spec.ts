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
});
