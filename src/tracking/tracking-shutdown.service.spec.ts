import { TrackingShutdownService } from './tracking-shutdown.service';

it('drains only sockets on the stopping replica and is idempotent', async () => {
  jest.useFakeTimers();
  try {
    const local = { emit: jest.fn(), disconnectSockets: jest.fn() };
    const server = {
      local,
      emit: jest.fn(),
      disconnectSockets: jest.fn(),
      use: jest.fn(),
    };
    const service = new TrackingShutdownService({ server } as any);
    const drain = service.beforeApplicationShutdown('SIGTERM');
    expect(local.emit).toHaveBeenCalledWith(
      'server_restart',
      expect.objectContaining({ reconnect: true }),
    );
    expect(local.disconnectSockets).not.toHaveBeenCalled();
    await service.beforeApplicationShutdown('SIGTERM');
    await jest.advanceTimersByTimeAsync(10000);
    await drain;
    expect(local.disconnectSockets).toHaveBeenCalledTimes(1);
    expect(server.emit).not.toHaveBeenCalled();
    expect(server.disconnectSockets).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
