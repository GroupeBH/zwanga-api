import { NotificationService } from './notifications.service';

describe('automatic ride push is deferred, not awaited over HTTP', () => {
  function fixture() {
    const query: any = { execute: jest.fn().mockResolvedValue({}) };
    for (const method of ['insert', 'into', 'values', 'onConflict'])
      query[method] = jest.fn(() => query);
    const manager: any = { createQueryBuilder: () => query };
    manager.transaction = jest.fn((callback) => callback(manager));
    const service: any = Object.assign(
      Object.create(NotificationService.prototype),
      {
        notificationRepository: { manager },
        deliverSavedNotification: jest.fn(() => new Promise(() => {})),
      },
    );
    return { service, query, manager };
  }
  it.each([
    'pickup_confirmed_automatically',
    'dropoff_confirmed_automatically',
    'destination_proximity',
    'passenger_destination_proximity',
  ])(
    '%s returns after the durable outbox write, even if push HTTP would never return',
    async (type) => {
      const f = fixture();
      expect(
        await f.service.sendNotification(
          'old-token',
          'Title',
          'Body',
          { type, bookingId: 'booking' },
          'recipient',
        ),
      ).toBe(true);
      expect(f.query.values).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'recipient',
          fcmToken: '',
          eventKey: `ride-progress:booking:${type}:recipient`,
          status: 'pending',
        }),
      );
      expect(f.service.deliverSavedNotification).not.toHaveBeenCalled();
      expect(f.query.execute).toHaveBeenCalledTimes(1);
      expect(f.manager.transaction).not.toHaveBeenCalled();
    },
  );
  it('waits for the single INSERT before acknowledging the alert', async () => {
    const f = fixture();
    let persist!: () => void;
    f.query.execute.mockReturnValue(new Promise<void>(resolve => { persist = resolve; }));
    let acknowledged = false;
    const pending = f.service.sendNotification('', 'Title', 'Body', {
      type: 'pickup_confirmed_automatically', bookingId: 'booking',
    }, 'recipient').then(() => { acknowledged = true; });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(f.service.deliverSavedNotification).not.toHaveBeenCalled();
    persist();
    await pending;
    expect(acknowledged).toBe(true);
    expect(f.service.deliverSavedNotification).not.toHaveBeenCalled();
  });
  it('does not report a successful enqueue when storage fails', async () => {
    const f = fixture();
    f.query.execute.mockRejectedValue(new Error('storage failed'));
    await expect(
      f.service.sendNotification(
        'token',
        'Title',
        'Body',
        { type: 'pickup_confirmed_automatically', bookingId: 'booking' },
        'recipient',
      ),
    ).rejects.toThrow('storage failed');
    expect(f.service.deliverSavedNotification).not.toHaveBeenCalled();
  });
});
