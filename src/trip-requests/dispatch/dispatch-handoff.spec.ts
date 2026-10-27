import { DriverDispatchService } from './dispatch.service';
import { TripRequestStatus } from '../entities/trip-request.entity';

describe('immediate refusal handoff', () => {
  const fixture = () => {
    const request = { id: 'request', status: TripRequestStatus.PENDING, selectedDriverId: null,
      tripId: null, departureDateMax: new Date(Date.now() + 60_000) };
    const offer = { id: 'offer', driverId: 'driver', requestId: request.id,
      status: 'pending', expiresAt: new Date(Date.now() + 30_000) };
    const urgent = jest.fn().mockResolvedValue(undefined);
    const query = jest.fn(async (sql: string) => sql.startsWith('SELECT') ? [offer] : []);
    const manager = { query, getRepository: () => ({ findOne: jest.fn(async () => request) }) };
    const transaction = jest.fn(async (work: (m: any) => Promise<unknown>) => {
      const result = await work(manager);
      expect(urgent).not.toHaveBeenCalled();
      return result;
    });
    const service = new DriverDispatchService({ query, transaction } as any,
      { get: () => 'true' } as any, { dispatchUrgentNotifications: urgent } as any);
    const allocate = jest.spyOn(service as any, 'allocateNext').mockResolvedValue(undefined);
    const tick = jest.spyOn(service, 'tick').mockResolvedValue(undefined);
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    return { service, request, offer, manager, query, transaction, allocate, urgent, tick, warn };
  };

  it('allocates after recording the refusal under the same transaction, then starts urgent delivery', async () => {
    const f = fixture(); f.service['ticking'] = true;
    f.allocate.mockImplementation(async () => {
      expect(f.query).toHaveBeenCalledWith(
        'UPDATE trip_request_dispatch_offers SET status = $2 WHERE id = $1', ['offer', 'declined']);
      expect(f.urgent).not.toHaveBeenCalled();
    });
    await expect(f.service.respond('driver', 'offer', 'decline')).resolves.toEqual({ status: 'declined', requestId: 'request' });
    expect(f.allocate).toHaveBeenCalledWith(f.manager, f.request);
    expect(f.urgent).toHaveBeenCalledTimes(1);
    expect(f.tick).not.toHaveBeenCalled();
  });

  it('does not allocate again for a duplicate refusal', async () => {
    const f = fixture(); f.offer.status = 'declined';
    await expect(f.service.respond('driver', 'offer', 'decline')).resolves.toMatchObject({ status: 'declined' });
    expect(f.allocate).not.toHaveBeenCalled();
  });

  it('does not launch a push when the transaction cannot commit', async () => {
    const f = fixture();
    f.transaction.mockImplementation(async work => { await work(f.manager); throw new Error('commit failed'); });
    await expect(f.service.respond('driver', 'offer', 'decline')).rejects.toThrow('commit failed');
    expect(f.urgent).not.toHaveBeenCalled();
  });

  it('propagates handoff failure so refusal and successor roll back together', async () => {
    const f = fixture(); f.allocate.mockRejectedValue(new Error('database unavailable'));
    await expect(f.service.respond('driver', 'offer', 'decline')).rejects.toThrow('database unavailable');
    expect(f.urgent).not.toHaveBeenCalled();
  });

  it('keeps the committed acknowledgement when the push provider fails', async () => {
    const f = fixture(); f.urgent.mockRejectedValue(new Error('push unavailable'));
    await expect(f.service.respond('driver', 'offer', 'decline')).resolves.toMatchObject({ status: 'declined' });
    expect(f.warn).toHaveBeenCalledWith('Dispatch response push delivery deferred.');
  });

  it.each(['cancelled', 'expired-request', 'expired-offer'])('does not advance after %s', async state => {
    const f = fixture();
    if (state === 'cancelled') f.request.status = TripRequestStatus.CANCELLED;
    if (state === 'expired-request') f.request.departureDateMax = new Date(0);
    if (state === 'expired-offer') f.offer.expiresAt = new Date(0);
    await expect(f.service.respond('driver', 'offer', 'decline')).rejects.toThrow();
    expect(f.allocate).not.toHaveBeenCalled();
    expect(f.urgent).not.toHaveBeenCalled();
  });
});
