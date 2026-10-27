import { NotificationService } from './notifications.service';
describe('urgent drain', () => {
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
