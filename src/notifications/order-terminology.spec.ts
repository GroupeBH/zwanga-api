import { androidDriverBackup } from './android-driver-backup';
import { assertRequestDriverProximity } from '../trip-requests/request-proximity';
import { assertSequentialInvitation } from '../trip-requests/dispatch/sequential-policy';

describe('public order terminology without contract changes', () => {
  it.each(['trip_request_nearby', 'driver_dispatch_offer'])('uses commande in the Android fallback for %s', type => {
    const data = { type, tripRequestId: 'request', offerId: 'offer', driverId: 'driver' };
    const notification = { title: '', body: '', data } as never;
    const payload = androidDriverBackup(notification, data);
    expect(payload.title).toBe('Commande à consulter');
    expect(payload.type).toBe(type);
    expect(payload.driverId).toBe('driver');
    expect(payload.channelId).toBe('driver-alert-backup-v1');
    expect(payload.tag).toBe(type === 'driver_dispatch_offer' ? 'ride-backup-dispatch-offer' : 'ride-backup-nearby-request');
  });
  it('keeps reservation distinct from an order', () => {
    const data = { type: 'new_booking', bookingId: 'booking' };
    expect(androidDriverBackup({ title: '', body: '', data } as never, data).title).toBe('Réservation à traiter');
  });
  it('preserves the expiry code and describes a commande', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    await expect(assertSequentialInvitation(manager as never, { id: 'request', sequentialDispatch: true }, 'driver'))
      .rejects.toMatchObject({ response: { code: 'REQUEST_INVITATION_EXPIRED', message: 'Cette commande a été proposée à un autre conducteur.' } });
    expect(manager.query.mock.calls[0][1]).toEqual(['request', 'driver', ['driver'], null]);
  });
  it('describes an unavailable commande without weakening the proximity check', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    await expect(assertRequestDriverProximity(manager as never, 'request', 'driver'))
      .rejects.toThrow('Cette commande est hors de votre zone de prise en charge. Actualisez votre position.');
    expect(manager.query.mock.calls[0][1]).toEqual(['request', 'driver']);
    manager.query.mockResolvedValue([{}]);
    await expect(assertRequestDriverProximity(manager as never, 'request', 'driver')).resolves.toBeUndefined();
  });
});
