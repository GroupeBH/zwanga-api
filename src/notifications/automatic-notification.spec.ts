import { NotificationService } from './notifications.service';
import { activePushUsers } from './active-push-users';

describe('Automatic notification coordination', () => {
  it('checks and enqueues within the same per-user transaction without sending push inline', async () => {
    const repository = {
      findOne: jest.fn(async () => null as unknown),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
    };
    const manager = { query: jest.fn(), getRepository: () => repository };
    const service = Object.create(NotificationService.prototype);
    service.notificationRepository = {
      manager: { transaction: (work: any) => work(manager) },
    };
    service.deliverSavedNotification = jest.fn();
    expect(
      await service.sendAutomaticNotification(
        'device',
        'title',
        'body',
        {},
        'user',
      ),
    ).toBe(true);
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['zwanga:automatic-push:user'],
    );
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        isAutomatic: true,
        eventKey: expect.stringMatching(/^automatic:user:/),
      }),
    );
    expect(service.deliverSavedNotification).not.toHaveBeenCalled();
    repository.findOne.mockResolvedValue({ id: 'already-queued' });
    expect(
      await service.sendAutomaticNotification(
        'device',
        'title',
        'body',
        {},
        'user',
      ),
    ).toBe(false);
    expect(repository.save).toHaveBeenCalledTimes(1);
  });
  it('reads recipients in bounded keyset batches', async () => {
    const batch = Array.from({ length: 100 }, (_, n) => ({
      id: String(n),
      fcmToken: 'device',
    }));
    const find = jest
      .fn()
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce([{ id: 'last', fcmToken: ' ' }]);
    const seen = [];
    for await (const user of activePushUsers({ find } as never))
      seen.push(user.id);
    expect(seen).toHaveLength(100);
    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[0][0]).toMatchObject({
      take: 100,
      order: { id: 'ASC' },
    });
    expect(find.mock.calls[1][0].where.id.value).toBe('99');
  });
});
