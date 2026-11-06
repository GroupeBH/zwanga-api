import { DataSource } from 'typeorm';
import { TripRequestsService } from '../src/trip-requests/trip-requests.service';
import { TripRequest } from '../src/trip-requests/entities/trip-request.entity';
import { DriverOffer } from '../src/trip-requests/entities/driver-offer.entity';
import { User } from '../src/users/entities/user.entity';
import { Vehicle } from '../src/vehicles/entities/vehicle.entity';
import { Notification } from '../src/notifications/entities/notification.entity';
import { requestMapDriver, requestSearchMap } from '../src/trip-requests/request-search-map';
import { rejectDriverOffer } from '../src/trip-requests/reject-driver-offer';
import { declineRequestForDriver } from '../src/trip-requests/request-refusal';
import { retireRequestInvitations } from '../src/trip-requests/dispatch/retire-request-invitations';
import { isRideResponseDeliverable } from '../src/notifications/ride-response-delivery';
import { NotificationService } from '../src/notifications/notifications.service';
import { ConfigService } from '@nestjs/config';

type Fixture = { source: DataSource; driver: () => Promise<{ user: User; vehicle: Vehicle }>;
  request: (immediate?: boolean, seats?: number) => Promise<TripRequest>; editor: () => TripRequestsService };

/** Registered in the disposable loopback PostGIS suite, never the application's DB. */
export function counterOfferPostgresTests(context: () => Fixture) {
  const prepare = async () => {
    const { source, driver, request, editor } = context();
    const d = await driver(), r = await request(true, 2);
    await source.getRepository(TripRequest).update(r.id, { sequentialDispatch: true });
    return { source, d, r, edits: editor(), dto: { vehicleId: d.vehicle.id, pricePerSeat: 1500 } };
  };
  const notification = (source: DataSource, id: string) => source.getRepository(Notification)
    .createQueryBuilder('n').where("n.data->>'offerId'=:id AND n.data->>'type'='driver_offer'", { id }).getOneOrFail();

  it('counteroffer: resolves an opaque map marker only for its owner and currently eligible request', async () => {
    const { source, d, r } = await prepare();
    const map = await requestSearchMap(source.manager, r.passengerId, r.id);
    expect(map.vehicles).toHaveLength(1);
    const marker = map.vehicles[0].id;
    const resolved = await requestMapDriver(source.manager, r.passengerId, r.id, marker);
    expect(resolved).toMatchObject({ driverId: d.user.id, vehicleType: 'car' });
    expect(Object.keys(resolved).sort()).toEqual(['driverId', 'positionUpdatedAt', 'vehicleType']);
    await expect(requestMapDriver(source.manager, d.user.id, r.id, marker)).rejects.toMatchObject({ status: 404 });
    const another = await context().request();
    await expect(requestMapDriver(source.manager, another.passengerId, another.id, marker)).rejects.toMatchObject({ status: 404 });
    await declineRequestForDriver(source.manager, d.user.id, r.id);
    await expect(requestMapDriver(source.manager, r.passengerId, r.id, marker)).rejects.toMatchObject({ status: 404 });
  });

  it('counteroffer: commits the negotiated price and ringing outbox together, without assigning or charging', async () => {
    const { source, d, r, edits, dto } = await prepare();
    const offer = await edits.proposeCounterOffer(d.user.id, r.id, dto);
    expect(Number(offer.pricePerSeat)).toBe(1500);
    const current = await source.getRepository(TripRequest).findOneByOrFail({ id: r.id });
    expect(current).toMatchObject({ status: 'offers_received', selectedDriverId: null, selectedPricePerSeat: null, tripId: null });
    const [invitation] = await source.query('SELECT * FROM trip_request_dispatch_offers WHERE "requestId"=$1', [r.id]);
    expect(invitation).toMatchObject({ driverId: d.user.id, phase: 'passenger', status: 'pending' });
    expect(new Date(invitation.expiresAt).getTime()).toBeGreaterThan(Date.now() + 90000);
    const notice = await notification(source, offer.id);
    expect(notice).toMatchObject({ userId: r.passengerId, status: 'pending', data: {
      type: 'driver_offer', ringAlert: 'counter-offer-v1', pricePerSeat: 1500, offerId: offer.id } });
    expect(await isRideResponseDeliverable(source.manager, notice)).toBe(true);
    // The actual durable socket publisher uses the same payload as the push worker.
    const publish = jest.fn().mockReturnValue(true);
    const worker = new NotificationService(new ConfigService({}), source.getRepository(Notification),
      source.getRepository(User), source.getRepository(TripRequest), { isBound: () => true, publish } as any);
    await worker.dispatchRealtimeNotifications();
    expect(publish).toHaveBeenCalledWith(r.passengerId, expect.objectContaining({ kind: 'incoming', data: expect.objectContaining({
      type: 'driver_offer', offerId: offer.id, passengerId: r.passengerId, ringAlert: 'counter-offer-v1' }) }));
  });

  it('counteroffer: rolls back the offer and lease when persisting the alert fails', async () => {
    const { source, d, r, edits, dto } = await prepare();
    await source.query('ALTER TABLE notifications ADD CONSTRAINT counteroffer_test_outbox CHECK (false) NOT VALID');
    try {
      await expect(edits.proposeCounterOffer(d.user.id, r.id, dto)).rejects.toThrow();
      expect(await source.getRepository(DriverOffer).countBy({ tripRequestId: r.id })).toBe(0);
      expect(await source.query('SELECT 1 FROM trip_request_dispatch_offers WHERE "requestId"=$1', [r.id])).toHaveLength(0);
      expect((await source.getRepository(TripRequest).findOneByOrFail({ id: r.id })).status).toBe('pending');
    } finally { await source.query('ALTER TABLE notifications DROP CONSTRAINT counteroffer_test_outbox'); }
  });

  it('counteroffer: concurrent conductors cannot both reserve the passenger decision', async () => {
    const { source, d, r, edits, dto } = await prepare(), other = await context().driver();
    const results = await Promise.allSettled([
      edits.proposeCounterOffer(d.user.id, r.id, dto),
      context().editor().proposeCounterOffer(other.user.id, r.id, { ...dto, vehicleId: other.vehicle.id }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await source.getRepository(DriverOffer).countBy({ tripRequestId: r.id })).toBe(1);
    expect(await source.query('SELECT 1 FROM trip_request_dispatch_offers WHERE "requestId"=$1 AND status=\'pending\'', [r.id])).toHaveLength(1);
  });

  it('counteroffer: acceptance requires ownership, stores the agreed price, and rejects a later withdrawal', async () => {
    const { source, d, r, edits, dto } = await prepare();
    const offer = await edits.proposeCounterOffer(d.user.id, r.id, dto);
    await expect(edits.acceptDriverOffer(d.user.id, r.id, { offerId: offer.id })).rejects.toMatchObject({ status: 404 });
    await edits.acceptDriverOffer(r.passengerId, r.id, { offerId: offer.id });
    const current = await source.getRepository(TripRequest).findOneByOrFail({ id: r.id });
    expect(current.status).toBe('driver_selected'); expect(current.selectedDriverId).toBe(d.user.id);
    expect(Number(current.selectedPricePerSeat)).toBe(1500);
    const receipt = await source.getRepository(Notification).findOneByOrFail({ eventKey: `offer-accepted:${offer.id}` });
    expect(receipt).toMatchObject({ userId: d.user.id, fcmToken: '', data: { type: 'offer_accepted',
      role: 'driver', driverId: d.user.id, passengerId: r.passengerId, tripRequestId: r.id } });
    expect(await isRideResponseDeliverable(source.manager, receipt)).toBe(true);
    const publish = jest.fn().mockReturnValue(true);
    const worker = new NotificationService(new ConfigService({}), source.getRepository(Notification),
      source.getRepository(User), source.getRepository(TripRequest), { isBound: () => true, publish } as any);
    await worker.dispatchRealtimeNotifications();
    expect(publish).toHaveBeenCalledWith(d.user.id, expect.objectContaining({ kind: 'incoming', data: expect.objectContaining({
      type: 'offer_accepted', offerId: offer.id, driverId: d.user.id, passengerId: r.passengerId }) }));
    expect((await notification(source, offer.id)).isActive).toBe(false);
    expect(await isRideResponseDeliverable(source.manager, await notification(source, offer.id))).toBe(false);
    await expect(declineRequestForDriver(source.manager, d.user.id, r.id)).rejects.toMatchObject({ status: 409 });
    await expect(rejectDriverOffer(source.manager, r.passengerId, r.id, offer.id)).rejects.toThrow();
  });

  it('counteroffer: acceptance rolls back if its driver receipt cannot be persisted', async () => {
    const { source, d, r, edits, dto } = await prepare();
    const offer = await edits.proposeCounterOffer(d.user.id, r.id, dto);
    await source.query('ALTER TABLE notifications ADD CONSTRAINT acceptance_test_outbox CHECK (false) NOT VALID');
    try {
      await expect(edits.acceptDriverOffer(r.passengerId, r.id, { offerId: offer.id })).rejects.toThrow();
      expect((await source.getRepository(DriverOffer).findOneByOrFail({ id: offer.id })).status).toBe('pending');
      expect((await source.getRepository(TripRequest).findOneByOrFail({ id: r.id })).selectedDriverId).toBeNull();
    } finally { await source.query('ALTER TABLE notifications DROP CONSTRAINT acceptance_test_outbox'); }
  });

  it.each(['reject', 'withdraw'])('counteroffer: %s retires the alert, releases a direct target and permits another driver', async decision => {
    const { source, d, r, edits, dto } = await prepare();
    await source.getRepository(TripRequest).update(r.id, { targetDriverId: d.user.id });
    const offer = await edits.proposeCounterOffer(d.user.id, r.id, dto);
    if (decision === 'reject') {
      await expect(rejectDriverOffer(source.manager, d.user.id, r.id, offer.id)).rejects.toMatchObject({ status: 404 });
      await rejectDriverOffer(source.manager, r.passengerId, r.id, offer.id);
      await rejectDriverOffer(source.manager, r.passengerId, r.id, offer.id); // retry is harmless
    } else await declineRequestForDriver(source.manager, d.user.id, r.id);
    expect((await notification(source, offer.id)).isActive).toBe(false);
    expect((await source.getRepository(TripRequest).findOneByOrFail({ id: r.id })).targetDriverId).toBeNull();
    const other = await context().driver();
    const next = await edits.proposeCounterOffer(other.user.id, r.id, { ...dto, vehicleId: other.vehicle.id });
    expect(next.id).not.toBe(offer.id);
  });

  it('counteroffer: a timed out decision cannot be accepted and is retired before the queue resumes', async () => {
    const { source, d, r, edits, dto } = await prepare();
    const offer = await edits.proposeCounterOffer(d.user.id, r.id, dto);
    await source.query('UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval \'1 second\' WHERE "requestId"=$1', [r.id]);
    await expect(edits.acceptDriverOffer(r.passengerId, r.id, { offerId: offer.id })).rejects.toThrow();
    expect(await isRideResponseDeliverable(source.manager, await notification(source, offer.id))).toBe(false);
    await source.transaction(manager => retireRequestInvitations(manager, r.id, false));
    expect((await source.getRepository(DriverOffer).findOneByOrFail({ id: offer.id })).status).toBe('cancelled');
    expect((await notification(source, offer.id)).isActive).toBe(false);
  });
}
