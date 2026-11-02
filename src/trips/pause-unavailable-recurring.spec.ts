import { pauseUnavailableRecurring } from './pause-unavailable-recurring';
import { enqueueTransactionalNotification } from '../notifications/transactional-notification';
jest.mock('../notifications/transactional-notification', () => ({ enqueueTransactionalNotification: jest.fn() }));

describe('recurring vehicle failure recovery', () => {
  beforeEach(() => jest.clearAllMocks());
  function setup(rows: unknown[]) {
    const query = jest.fn().mockResolvedValue([]).mockImplementation(async (sql: string) => sql.startsWith('WITH paused') ? rows : []);
    const manager = { query, transaction: async (work: Function) => work(manager) };
    const template = { id: 'template', vehicleId: 'vehicle', driverId: 'driver', updatedAt: new Date('2026-11-02T00:00:00Z') };
    return { manager, template, query };
  }
  it('queues the pause notification in the same transaction and does not notify after a concurrent repair', async () => {
    const ctx = setup([{ id: 'template' }]);
    expect(await pauseUnavailableRecurring(ctx.manager as any, ctx.template as any)).toBe(true);
    expect(enqueueTransactionalNotification).toHaveBeenCalledWith(ctx.manager, expect.objectContaining({
      userId: 'driver', eventKey: 'recurring-unavailable:template:2026-11-02T00:00:00.000Z',
    }));
    const repaired = setup([]);
    expect(await pauseUnavailableRecurring(repaired.manager as any, repaired.template as any)).toBe(false);
    expect(enqueueTransactionalNotification).toHaveBeenCalledTimes(1);
    expect(ctx.query.mock.calls[2][0]).toContain('NOT EXISTS');
    expect(ctx.query.mock.calls[2][0]).toContain('date_trunc(\'milliseconds\', "updatedAt")=$3::timestamp');
  });
  it('propagates outbox failures so the pause rolls back and can be retried', async () => {
    const ctx = setup([{ id: 'template' }]);
    jest.mocked(enqueueTransactionalNotification).mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(pauseUnavailableRecurring(ctx.manager as any, ctx.template as any)).rejects.toThrow('outbox unavailable');
  });
});
