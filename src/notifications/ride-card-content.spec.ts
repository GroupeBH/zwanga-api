import { rideCardContent } from './ride-card-content';
import { nativeAndroidDriverPush } from './native-android-driver-push';
import { iosDriverPush } from './ios-driver-push';
import type { Notification } from './entities/notification.entity';
const fixture = (data: Record<string, unknown> = {}) => ({ id: 'local-notification', title: 'Nouvelle demande', body: 'Ancien texte : 2500 FC',
  data: { type: 'trip_request_nearby', driverId: 'driver', tripRequestId: 'request',
    ridePriceKind: 'budget', ridePricePerSeat: '2500', rideDeparture: 'Départ test', rideArrival: 'Arrivée test', ...data },
}) as Notification;
describe('price and route as text only', () => {
  it.each(['new_booking','trip_request_nearby','driver_dispatch_offer'])('shows price and route for %s in native Android and APNs', type => {
    const n = fixture({ type }), until = new Date(Date.now()+60000).toISOString();
    const android = nativeAndroidDriverPush(n, 'synthetic', until);
    const ios = iosDriverPush(n, 'synthetic', until);
    expect(android.data.title.replace(/[\u202f\u00a0]/g,' ')).toBe('Zwanga · Budget : 2 500 FC / place');
    expect(android.data.message).toContain('Départ test → Arrivée test');
    expect(ios.apns?.payload.aps.alert).toMatchObject({ title: android.data.title, body: android.data.message });
    expect(android.data.driverId).toBe('driver'); expect(android.data.ringUntil).toBe(until);
    expect(android.data).not.toHaveProperty('rideMapUrl');
    expect(ios.apns?.payload.aps).not.toHaveProperty('mutableContent');
    expect(Buffer.byteLength(JSON.stringify(android.data))).toBeLessThan(4000);
  });
  it('distinguishes a known free ride from a missing or invalid amount', () => {
    expect(rideCardContent(fixture({ ridePriceKind:'fare', ridePricePerSeat:'0' })).title).toBe('Zwanga · Gratuit');
    for (const raw of [undefined, null, '', '-1', 'NaN', '1e3', '<b>100</b>', '12345678901']) {
      expect(rideCardContent(fixture({ ridePricePerSeat:raw }))).toEqual({ title:'Nouvelle demande', body:'Ancien texte : 2500 FC' });
    }
    expect(rideCardContent(fixture({ ridePriceKind:undefined })).title).toBe('Nouvelle demande');
  });
  it('preserves the passenger response and unrelated notifications', () => {
    expect(rideCardContent(fixture({type:'booking_response'}))).toEqual({title:'Nouvelle demande',body:'Ancien texte : 2500 FC'});
  });
  it('sanitizes route markup and fits a long multi-byte payload', () => {
    const n = fixture({ rideDeparture:'<b>Départ</b>\n', rideArrival:'🚗'.repeat(2000), invitationText:'🚗'.repeat(2000) });
    expect(rideCardContent(n).body).not.toContain('<b>');
    expect(Buffer.byteLength(JSON.stringify(nativeAndroidDriverPush(n,'synthetic',new Date().toISOString()).data))).toBeLessThan(4000);
  });
});
