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
import { RequestPriceNegotiation1780000122000 } from '../src/database/migrations/1780000122000-RequestPriceNegotiation';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { TripRequestsController } from '../src/trip-requests/trip-requests.controller';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import supertest from 'supertest';

type Fixture = { source: DataSource; driver: () => Promise<{ user: User; vehicle: Vehicle }>;
  request: (immediate?: boolean, seats?: number) => Promise<TripRequest>; editor: () => TripRequestsService };

/** Registered in the disposable loopback PostGIS suite, never the application's DB. */
export function counterOfferPostgresTests(context: () => Fixture) {
  const prepare = async () => {
    const { source, driver, request, editor } = context();
    const d = await driver(), r = await request(true, 2);
    await source.getRepository(TripRequest).update(r.id, { sequentialDispatch: true });
    // Keep the negotiated fare above the current 2,500 CDF passenger budget.
    return { source, d, r, edits: editor(), dto: { vehicleId: d.vehicle.id, pricePerSeat: 3000, negotiationVersion: 1 as const } };
  };
  const notification = (source: DataSource, id: string) => source.getRepository(Notification)
    .createQueryBuilder('n').where("n.data->>'offerId'=:id AND n.data->>'type'='driver_offer'", { id }).getOneOrFail();

  it('bargaining HTTP: real controller, validation, service and PostGIS preserve the same command through every round', async () => {
    const { source, d, r, edits, dto } = await prepare();
    // Restore real reads/projections; only premium/media adapters and authentication identity are synthetic.
    (edits.findOne as jest.Mock).mockRestore();
    (edits as any).sanitizeDriverOffer.mockRestore();
    (edits as any).subscriptionsService.getPremiumOverview = async () => ({ isPremium: false, premiumBadgeEnabled: false });
    (edits as any).fileUploadService.getPresignedUrlIfS3Key = async (value: string) => value;
    const module = await Test.createTestingModule({ controllers: [TripRequestsController], providers: [{ provide: TripRequestsService, useValue: edits }] })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate: (context: any) => {
        const request = context.switchToHttp().getRequest();
        const actor = request.headers['x-local-actor'];
        if (![d.user.id, r.passengerId].includes(actor)) return false;
        request.user = { userId: actor }; return true;
      } }).compile();
    const app: INestApplication = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    try {
      await app.init(); const http = app.getHttpServer(); const path = `/trip-requests/${r.id}`;
      const initial = (await supertest(http).post(`${path}/counter-offer`).set('x-local-actor', d.user.id).send(dto).expect(201)).body;
      await supertest(http).post(`${path}/offers/${initial.id}/passenger-price`).set('x-local-actor', r.passengerId).send({ pricePerSeat: 2700, driverId: d.user.id }).expect(400);
      const passenger = (await supertest(http).post(`${path}/offers/${initial.id}/passenger-price`).set('x-local-actor', r.passengerId).send({ pricePerSeat: 2700 }).expect(201)).body;
      const counter = passenger.driverOffers.find((offer: DriverOffer) => offer.status === 'pending');
      expect(passenger.id).toBe(r.id); expect(counter.negotiationStage).toBe('passenger_counter');
      const driverView = (await supertest(http).get(path).set('x-local-actor', d.user.id).expect(200)).body;
      expect(driverView.driverOffers.some((o: DriverOffer) => o.id === counter.id)).toBe(true);
      const driver = (await supertest(http).post(`${path}/offers/${counter.id}/final-price`).set('x-local-actor', d.user.id).send({ pricePerSeat: 2800 }).expect(201)).body;
      const final = driver.driverOffers.find((offer: DriverOffer) => offer.status === 'pending');
      expect(final.negotiationStage).toBe('driver_final');
      await supertest(http).post(`${path}/offers/${counter.id}/accept-passenger-price`).set('x-local-actor', d.user.id).send({}).expect(400);
      await supertest(http).get(`${path}/offers/${final.id}/alternatives`).set('x-local-actor', r.passengerId).expect(200);
      const agreed = (await supertest(http).post(`${path}/accept-offer`).set('x-local-actor', r.passengerId).send({ offerId: final.id }).expect(201)).body;
      expect(agreed).toMatchObject({ id: r.id, status: 'driver_selected', selectedDriver: { id: d.user.id }, selectedPricePerSeat: 2800 });
      expect(await source.getRepository(DriverOffer).countBy({ tripRequestId: r.id })).toBe(3);
    } finally { await app.close(); }
  });

  it('bargaining: passenger counters, driver proposes final price, passenger accepts only the last revision', async () => {
    const { source, d, r, edits, dto } = await prepare();
    const first = await edits.proposeCounterOffer(d.user.id, r.id, dto);
    await edits.negotiatePrice(r.passengerId, r.id, first.id, 2700, 'passenger_counter');
    const repo = source.getRepository(DriverOffer);
    const counter = await repo.findOneByOrFail({ tripRequestId: r.id, negotiationStage: 'passenger_counter' });
    expect((await repo.findOneByOrFail({ id: first.id })).status).toBe('cancelled');
    expect(counter.previousOfferId).toBe(first.id);
    const notice = await notification(source, counter.id);
    expect(notice.userId).toBe(d.user.id);
    const delivery = new NotificationService(new ConfigService(), source.getRepository(Notification), source.getRepository(User), source.getRepository(TripRequest));
    const transport = delivery as unknown as { passengerRingData: (n: Notification) => Record<string, unknown> };
    expect(transport.passengerRingData(notice)).toMatchObject({ driverId: d.user.id, passengerId: r.passengerId, role: 'driver', negotiationStage: 'passenger_counter' });
    expect(await isRideResponseDeliverable(source.manager, notice)).toBe(true);
    expect(await isRideResponseDeliverable(source.manager, { ...notice, userId: r.passengerId })).toBe(false);
    await expect(edits.acceptDriverOffer(r.passengerId, r.id, { offerId: first.id })).rejects.toThrow();
    await expect(edits.acceptDriverOffer(r.passengerId, r.id, { offerId: counter.id })).rejects.toThrow();
    await edits.negotiatePrice(d.user.id, r.id, counter.id, 2800, 'driver_final');
    const final = await repo.findOneByOrFail({ tripRequestId: r.id, negotiationStage: 'driver_final' });
    expect(await isRideResponseDeliverable(source.manager, notice)).toBe(false);
    await expect(edits.negotiatePrice(r.passengerId, r.id, final.id, 2600, 'passenger_counter')).rejects.toThrow();
    await edits.acceptDriverOffer(r.passengerId, r.id, { offerId: final.id });
    expect(await source.getRepository(TripRequest).findOneByOrFail({ id: r.id }))
      .toMatchObject({ selectedDriverId: d.user.id, selectedPricePerSeat: '2800.00' });
  });

  it('bargaining: legacy driver offers remain accept/reject only', async () => {
    const { source, d, r, edits, dto } = await prepare();
    const first = await edits.proposeCounterOffer(d.user.id, r.id, { vehicleId: dto.vehicleId, pricePerSeat: dto.pricePerSeat });
    expect(first.negotiationStage).toBeNull();
    await expect(edits.negotiatePrice(r.passengerId, r.id, first.id, 2700, 'passenger_counter')).rejects.toThrow();
    await edits.acceptDriverOffer(r.passengerId, r.id, { offerId: first.id });
    expect((await source.getRepository(TripRequest).findOneByOrFail({ id: r.id })).selectedDriverId).toBe(d.user.id);
  });

  it('bargaining: driver accepts passenger price and notifies the passenger, not himself', async () => {
    const { source, d, r, edits, dto } = await prepare();
    const first = await edits.proposeCounterOffer(d.user.id, r.id, dto);
    await edits.negotiatePrice(r.passengerId, r.id, first.id, 2700, 'passenger_counter');
    const counter = await source.getRepository(DriverOffer).findOneByOrFail({ tripRequestId: r.id, negotiationStage: 'passenger_counter' });
    await expect(edits.acceptPassengerPrice(r.passengerId, r.id, counter.id)).rejects.toThrow();
    await edits.acceptPassengerPrice(d.user.id, r.id, counter.id);
    expect(await source.getRepository(TripRequest).findOneByOrFail({ id: r.id }))
      .toMatchObject({ selectedDriverId: d.user.id, selectedPricePerSeat: '2700.00' });
    const receipt = await source.getRepository(Notification).findOneByOrFail({ eventKey: `passenger-price-accepted:${counter.id}` });
    expect(receipt.userId).toBe(r.passengerId);
    expect(await isRideResponseDeliverable(source.manager, receipt)).toBe(true);
    expect(await source.getRepository(Notification).countBy({ eventKey: `offer-accepted:${counter.id}` })).toBe(0);
  });

  it('bargaining: duplicate counters serialize, wrong actors cannot set a price, final refusal releases the queue', async () => {
    const { source, d, r, edits, dto } = await prepare();
    const first = await edits.proposeCounterOffer(d.user.id, r.id, dto);
    await expect(edits.negotiatePrice(d.user.id, r.id, first.id, 2700, 'passenger_counter')).rejects.toThrow();
    const outcomes = await Promise.allSettled([2700, 2600].map(price => edits.negotiatePrice(r.passengerId, r.id, first.id, price, 'passenger_counter')));
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    const counter = await source.getRepository(DriverOffer).findOneByOrFail({ tripRequestId: r.id, negotiationStage: 'passenger_counter' });
    await edits.negotiatePrice(d.user.id, r.id, counter.id, 2900, 'driver_final');
    const final = await source.getRepository(DriverOffer).findOneByOrFail({ tripRequestId: r.id, negotiationStage: 'driver_final' });
    await edits.rejectOffer(r.passengerId, r.id, final.id);
    expect(await source.query(`SELECT 1 FROM trip_request_dispatch_offers WHERE "requestId"=$1 AND status='pending'`, [r.id])).toHaveLength(0);
    expect(await source.query(`SELECT 1 FROM trip_request_driver_refusals WHERE "requestId"=$1 AND "driverId"=$2`, [r.id, d.user.id])).toHaveLength(1);
    expect((await source.getRepository(TripRequest).findOneByOrFail({ id: r.id })).status).toBe('pending');
  });

  it('bargaining: alternatives exclude the negotiating driver, honor freshness and disclose aggregates only', async () => {
    const { source, d, r, edits, dto } = await prepare();
    const first = await edits.proposeCounterOffer(d.user.id, r.id, dto);
    expect(await edits.priceAlternatives(r.passengerId, r.id, first.id)).toMatchObject({ recent: 0, older: 0 });
    const other = await context().driver();
    const alternatives = await edits.priceAlternatives(r.passengerId, r.id, first.id);
    expect(alternatives).toMatchObject({ recent: 1, older: 0, radiusKm: 5 });
    expect(Object.keys(alternatives).sort()).toEqual(['generatedAt', 'offerId', 'older', 'radiusKm', 'recent', 'requestId', 'truncated']);
    await expect(edits.priceAlternatives(d.user.id, r.id, first.id)).rejects.toThrow();
    await source.query(`UPDATE driver_dispatch_presence SET "updatedAt"=now()-interval '2 hours' WHERE "driverId"=$1`, [other.user.id]);
    expect(await edits.priceAlternatives(r.passengerId, r.id, first.id)).toMatchObject({ recent: 0, older: 1 });
    await source.query(`UPDATE driver_dispatch_presence SET "updatedAt"=now()-interval '49 hours' WHERE "driverId"=$1`, [other.user.id]);
    expect(await edits.priceAlternatives(r.passengerId, r.id, first.id)).toMatchObject({ recent: 0, older: 0 });
  });

  it('bargaining: expired turns cannot restart negotiation or direct acceptance', async () => {
    const { source, d, r, edits, dto } = await prepare();
    const first = await edits.proposeCounterOffer(d.user.id, r.id, dto);
    await expect(edits.acceptTripRequest(d.user.id, r.id, { vehicleId: d.vehicle.id })).rejects.toThrow();
    await source.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second' WHERE "requestId"=$1`, [r.id]);
    await expect(edits.negotiatePrice(r.passengerId, r.id, first.id, 2700, 'passenger_counter')).rejects.toThrow();
    expect(await source.getRepository(DriverOffer).countBy({ tripRequestId: r.id })).toBe(1);
    expect((await source.getRepository(TripRequest).findOneByOrFail({ id: r.id })).selectedDriverId).toBeNull();
  });

  it('bargaining: driver withdrawal during the passenger counter releases the request', async () => {
    const { source, d, r, edits, dto } = await prepare();
    const first = await edits.proposeCounterOffer(d.user.id, r.id, dto);
    await edits.negotiatePrice(r.passengerId, r.id, first.id, 2700, 'passenger_counter');
    const counter = await source.getRepository(DriverOffer).findOneByOrFail({ tripRequestId: r.id, negotiationStage: 'passenger_counter' });
    await declineRequestForDriver(source.manager, d.user.id, r.id);
    expect(await source.getRepository(DriverOffer).countBy({ tripRequestId: r.id, status: 'pending' as never })).toBe(0);
    expect(await isRideResponseDeliverable(source.manager, await notification(source, counter.id))).toBe(false);
    await expect(edits.acceptPassengerPrice(d.user.id, r.id, counter.id)).rejects.toThrow();
  });

  it('bargaining: migration upgrades legacy rows, guards rollback and reapplies without losing prices', async () => {
    const { source, d, r, edits, dto } = await prepare();
    const first = await edits.proposeCounterOffer(d.user.id, r.id, dto);
    const migration = new RequestPriceNegotiation1780000122000();
    // synchronize supplies the new columns; recreate the production upgrade from the legacy schema.
    await source.query(`ALTER TABLE driver_offers DROP COLUMN "negotiationStage", DROP COLUMN "previousOfferId"`);
    await source.transaction(manager => migration.up(manager.queryRunner!));
    expect(await source.getRepository(DriverOffer).findOneByOrFail({ id: first.id })).toMatchObject({ negotiationStage: null, pricePerSeat: '3000.00' });
    await source.query(`UPDATE driver_offers SET "negotiationStage"='driver_initial' WHERE id=$1`, [first.id]);
    await expect(source.transaction(manager => migration.down(manager.queryRunner!))).rejects.toThrow(/pending price negotiations/);
    await source.query(`UPDATE driver_offers SET status='cancelled' WHERE id=$1`, [first.id]);
    await source.transaction(manager => migration.down(manager.queryRunner!));
    await source.transaction(manager => migration.up(manager.queryRunner!));
    expect(await source.getRepository(DriverOffer).findOneByOrFail({ id: first.id })).toMatchObject({ negotiationStage: null, pricePerSeat: '3000.00' });
    await expect(source.query(`UPDATE driver_offers SET "negotiationStage"='invalid' WHERE id=$1`, [first.id])).rejects.toThrow();
  });

  it.each([1500, 2499])('counteroffer: rejects a new fare of %s before saving an offer, lease or alert', async pricePerSeat => {
    const { source, d, r, edits, dto } = await prepare();
    await expect(edits.proposeCounterOffer(d.user.id, r.id, { ...dto, pricePerSeat }))
      .rejects.toMatchObject({ status: 400, response: {
        code: 'TRIP_PRICE_BELOW_MINIMUM', minimumPricePerSeat: 2500,
      } });
    expect(await source.getRepository(DriverOffer).countBy({ tripRequestId: r.id })).toBe(0);
    expect(await source.query('SELECT 1 FROM trip_request_dispatch_offers WHERE "requestId"=$1', [r.id])).toHaveLength(0);
    expect(await source.getRepository(Notification).count()).toBe(0);
    expect(await source.getRepository(TripRequest).findOneByOrFail({ id: r.id }))
      .toMatchObject({ status: 'pending', selectedDriverId: null, selectedPricePerSeat: null });
  });

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
    expect(Number(offer.pricePerSeat)).toBe(3000);
    const current = await source.getRepository(TripRequest).findOneByOrFail({ id: r.id });
    expect(current).toMatchObject({ status: 'offers_received', selectedDriverId: null, selectedPricePerSeat: null, tripId: null });
    const [invitation] = await source.query('SELECT * FROM trip_request_dispatch_offers WHERE "requestId"=$1', [r.id]);
    expect(invitation).toMatchObject({ driverId: d.user.id, phase: 'passenger', status: 'pending' });
    expect(new Date(invitation.expiresAt).getTime()).toBeGreaterThan(Date.now() + 90000);
    const notice = await notification(source, offer.id);
    expect(notice).toMatchObject({ userId: r.passengerId, status: 'pending', data: {
      type: 'driver_offer', ringAlert: 'counter-offer-v1', pricePerSeat: 3000, offerId: offer.id } });
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
      await expect(edits.proposeCounterOffer(d.user.id, r.id, dto)).rejects.toMatchObject({
        driverError: { code: '23514', constraint: 'counteroffer_test_outbox' },
      });
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
    expect(Number(current.selectedPricePerSeat)).toBe(3000);
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
      await expect(edits.acceptDriverOffer(r.passengerId, r.id, { offerId: offer.id })).rejects.toMatchObject({
        driverError: { code: '23514', constraint: 'acceptance_test_outbox' },
      });
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
