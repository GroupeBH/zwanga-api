import { hasUsableDriverLocation } from './driver-location-policy';
import { DriverDispatchService } from './dispatch.service';

describe('last known driver location', () => {
  it('uses opted-in locations regardless of their former deadline', () => {
    expect(hasUsableDriverLocation({ discoveryEnabled: true, expiresAt: new Date(0) })).toBe(true);
  });

  it('never treats an explicit opt-out as a usable location', () => {
    expect(hasUsableDriverLocation({ discoveryEnabled: false, expiresAt: new Date(99999) }, 1000)).toBe(false);
    expect(hasUsableDriverLocation(undefined)).toBe(false);
  });

  it('preserves ambiguous legacy deadlines until the next position update', () => {
    expect(hasUsableDriverLocation({ discoveryEnabled: null, expiresAt: new Date(1001) }, 1000)).toBe(true);
    expect(hasUsableDriverLocation({ discoveryEnabled: null, expiresAt: new Date(1000) }, 1000)).toBe(false);
  });

  it.each(['invalid', new Date(Date.now() + 60_000).toISOString()])('rejects invalid/future timestamps before database work: %s', async recordedAt => {
    const transaction = jest.fn();
    const service = new DriverDispatchService({ transaction } as never, { get: () => 'true' } as never, {} as never);
    await expect(service.recordPosition('driver', { latitude: -4.3, longitude: 15.31, accuracy: 20, recordedAt }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'DRIVER_POSITION_TIMESTAMP_INVALID' }) });
    expect(transaction).not.toHaveBeenCalled();
  });
});
