import { NotificationService } from './notifications.service';
describe('urgent drain', () => {
  it('runs only one acknowledgement recovery at a time without blocking the urgent lane', async () => {
    let release!: (value: unknown[]) => void;
    const query = jest.fn(() => new Promise<unknown[]>(resolve => { release = resolve; }));
    const lane = jest.fn().mockResolvedValue(0);
    const service:any = Object.assign(Object.create(NotificationService.prototype), {
      dispatchNotificationLane: lane, dispatchRealtimeNotifications: jest.fn().mockResolvedValue(undefined),
      notificationRepository: { manager: { query } }, logger: { warn: jest.fn() },
    });
    const first = service.recoverRideAcknowledgements();
    try {
      await service.recoverRideAcknowledgements(); await service.dispatchUrgentNotifications();
      expect(query).toHaveBeenCalledTimes(1); expect(lane).toHaveBeenCalledTimes(1);
    } finally { release([]); await first; }
    expect(service.recoveringRideAcknowledgements).toBe(false);
  });
  it('does not query acknowledgement recovery before starting fresh push and realtime', async () => {
    const recoveryQuery = jest.fn().mockRejectedValue(new Error('slow acknowledgement table'));
    const lane = jest.fn().mockResolvedValue(0), realtime = jest.fn().mockResolvedValue(undefined);
    const service:any = Object.assign(Object.create(NotificationService.prototype), {
      dispatchNotificationLane: lane, dispatchRealtimeNotifications: realtime,
      notificationRepository: { manager: { query: recoveryQuery } }, logger: { warn: jest.fn() },
    });
    await service.dispatchUrgentNotifications();
    expect(lane).toHaveBeenCalledWith(true); expect(realtime).toHaveBeenCalledTimes(1);
    expect(recoveryQuery).not.toHaveBeenCalled();
    await expect(service.recoverRideAcknowledgements()).resolves.toBeUndefined();
    expect(service.logger.warn).toHaveBeenCalledTimes(1);
    await service.dispatchUrgentNotifications(); expect(lane).toHaveBeenCalledTimes(2);
  });
  it('drains ten five-message batches for 50 drivers instead of stopping after five', async () => {
    const lane=jest.fn();for(let n=0;n<10;n++)lane.mockResolvedValueOnce(5);lane.mockResolvedValueOnce(0);
    const service:any=Object.assign(Object.create(NotificationService.prototype),{dispatchNotificationLane:lane,
      notificationRepository:{manager:{query:jest.fn().mockResolvedValue([])}},logger:{warn:jest.fn()}});
    await service.dispatchUrgentNotifications();expect(lane).toHaveBeenCalledTimes(11);
  });
  it('bounds a continuous backlog to twenty batches per drain',async()=>{
    const lane=jest.fn().mockResolvedValue(5);
    const service:any=Object.assign(Object.create(NotificationService.prototype),{dispatchNotificationLane:lane,
      notificationRepository:{manager:{query:jest.fn().mockResolvedValue([])}},logger:{warn:jest.fn()}});
    await service.dispatchUrgentNotifications();expect(lane).toHaveBeenCalledTimes(20);
  });
});
