import { SequentialDispatchService } from './sequential-dispatch.service';
import { assertRequestTarget } from '../target-driver-policy';
import { recordRequestRefusal } from '../request-refusal';
import { requestDriverVisibilitySql } from '../target-driver-policy';
import { recordRideNotificationReceipt } from '../../notifications/ride-notification-receipt';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { RideAlertChanges } from '../../notifications/ride-alert-changes';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { assertDriverCanOperate } from '../../users/driver-activation';
import { getVehicleMaxSeats, Vehicle } from '../../vehicles/entities/vehicle.entity';
import { TripRequest, TripRequestStatus } from '../entities/trip-request.entity';
import { DriverOffer, DriverOfferStatus } from '../entities/driver-offer.entity';
import { NotificationService } from '../../notifications/notifications.service';
import { enqueueTransactionalNotification, enqueueTransactionalNotifications } from '../../notifications/transactional-notification';
import { DriverPositionDto, DriverPresenceDto } from './dispatch.dto';
import { boundedInteger, DispatchDecision, dispatchOfferIsActionable } from './dispatch-policy';
import { enqueueScheduledRequestAlert } from './scheduled-request-alert';
import { enqueueSharedTripAlert } from './shared-trip-alert';
import { rideSpeechData } from '../../notifications/ride-speech-data';
import { ELIGIBLE_NEARBY_DRIVER_SQL, NEARBY_DRIVER_RADIUS_METERS } from './nearby-driver-policy';
import { enqueueStaleLocationReminders } from './stale-location-reminder';
import { hasUsableDriverLocation, USABLE_DRIVER_LOCATION_SQL } from './driver-location-policy';
import { acknowledgeNearbyRequest, declineNearbyRequest } from '../../notifications/nearby-request-cooldown';

interface DispatchOffer {
  id: string; requestId: string; driverId: string; vehicleId: string;
  seats: number; status: string; expiresAt: Date;
}

@Injectable()
export class DriverDispatchService {
  private readonly logger = new Logger(DriverDispatchService.name);
  private ticking = false;
  constructor(private readonly db: DataSource, private readonly config: ConfigService,
    private readonly notifications: NotificationService,
    @Optional() private readonly rideChanges?: RideAlertChanges,
    private readonly sequential?: SequentialDispatchService) {}

  get enabled() { return this.config.get<string>('DRIVER_DISPATCH_ENABLED') === 'true'; }
  async declineNearbyRequest(driverId: string, requestId: string) {
    const result = await declineNearbyRequest(this.db.manager, driverId, requestId);
    this.rideChanges?.enqueue({ kind: 'request', id: requestId, terminal: false });
    await this.sequential?.advance(requestId);
    return result;
  }
  async receiveRequestEvent(driverId: string, requestId: string, offerId: string) {
    const rows = await this.db.query(`SELECT id FROM trip_request_dispatch_offers
      WHERE id = $1 AND "requestId" = $2 AND "driverId" = $3`, [offerId, requestId, driverId]);
    if (!rows.length) throw new NotFoundException('Proposition introuvable.');
    return this.declineNearbyRequest(driverId, requestId);
  }
  async acknowledgeNotification(driverId: string, notificationId: string, stage: 'received' | 'displayed' = 'received', detail?: import('../../notifications/ride-notification-receipt').RideReceiptDetail) {
    const result = await recordRideNotificationReceipt(this.db.manager, driverId, notificationId, stage, detail);
    if (result.received) await acknowledgeNearbyRequest(this.db.manager, driverId, notificationId);
    return result;
  }
  private get responseSeconds() { if (this.sequential) return 40; return boundedInteger(this.config.get('DRIVER_DISPATCH_RESPONSE_SECONDS'), 60, 60, 120); }
  private get presenceSeconds() { return boundedInteger(this.config.get('DRIVER_DISPATCH_PRESENCE_SECONDS'), 90, 45, 180); }
  private get radiusMeters() { return NEARBY_DRIVER_RADIUS_METERS; }
  // Compatibility/freshness metadata only. Durable positions do not expire.
  private get positionSeconds() { return boundedInteger(this.config.get('DRIVER_DISPATCH_POSITION_SECONDS'), 300, 300, 900); }

  async notifyScheduledRequest(requestId: string): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.sequential) return this.sequential.advance(requestId);
    const queued = await this.db.transaction(manager => enqueueScheduledRequestAlert(
      manager, requestId, this.radiusMeters, driverId => this.isBusy(manager, driverId)));
    // No network operation while holding the request's transaction lock.
    if (queued) void this.notifications.dispatchTransactionalNotifications()
      .catch(() => this.logger.warn('Nearby request push delivery deferred.'));
    // A committed outbox entry remains queued even if delivery needs a retry.
    return queued;
  }

  async status(driverId: string) {
    if (!this.enabled) return { enabled: false, available: false, pendingOfferId: null };
    const [presence] = await this.db.query(`SELECT "vehicleId", "leaseId", seats, "expiresAt", "updatedAt", "discoveryEnabled"
      FROM driver_dispatch_presence p WHERE "driverId" = $1 AND ${USABLE_DRIVER_LOCATION_SQL}`, [driverId]);
    const [offer] = await this.db.query(`SELECT o.id FROM trip_request_dispatch_offers o
      JOIN trip_requests r ON r.id = o."requestId"
      WHERE o."driverId" = $1 AND o.status = 'pending' AND o."expiresAt" > now()
      AND r.status = 'pending' LIMIT 1`, [driverId]);
    const available = Boolean(presence) && !(await this.isBusy(this.db.manager, driverId));
    return { enabled: true, available, presence: presence ?? null,
      pendingOfferId: offer?.id ?? null, responseSeconds: this.responseSeconds,
      automatic: true, positionFreshSeconds: this.positionSeconds,
      locationPolicy: 'last_known', positionExpires: presence?.discoveryEnabled !== true };
  }

  /** Keep the latest known GPS fix, regardless of age, without re-enabling an opt-out. */
  async recordPosition(driverId: string, body: DriverPositionDto) {
    if (!this.enabled) return this.status(driverId);
    const recordedAt = new Date(body.recordedAt);
    const age = Date.now() - recordedAt.getTime();
    if (!Number.isFinite(age) || age < -5000)
      throw new BadRequestException({ code: 'DRIVER_POSITION_TIMESTAMP_INVALID',
        message: 'La date de la position est invalide ou dans le futur. Vérifiez l’heure du téléphone.' });
    await this.db.transaction(async manager => {
      const driver = await manager.getRepository(User).findOneBy({ id: driverId });
      if (!driver) throw new NotFoundException('Conducteur introuvable.');
      await assertDriverCanOperate(manager, driver);
      const [previous] = await manager.query('SELECT * FROM driver_dispatch_presence WHERE "driverId" = $1 FOR UPDATE', [driverId]);
      // Preserve the proposed vehicle while an invitation is awaiting a reply.
      const vehicle = (previous && await manager.getRepository(Vehicle).findOneBy({
        id: previous.vehicleId, ownerId: driverId, isActive: true,
      })) || await manager.getRepository(Vehicle).findOne({ where: { ownerId: driverId, isActive: true }, order: { updatedAt: 'DESC', id: 'ASC' } });
      if (!vehicle) return;
      await manager.query(`INSERT INTO driver_dispatch_presence
        ("driverId", "vehicleId", seats, position, "expiresAt", "leaseId", "updatedAt", "discoveryEnabled")
        VALUES ($1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,$6,$7,$8,true)
        ON CONFLICT ("driverId") DO UPDATE SET "vehicleId" = EXCLUDED."vehicleId", seats = EXCLUDED.seats,
          position = EXCLUDED.position, "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = EXCLUDED."updatedAt",
          "discoveryEnabled" = COALESCE(driver_dispatch_presence."discoveryEnabled", true),
          "locationReminderSentAt" = NULL
        WHERE driver_dispatch_presence."updatedAt" <= EXCLUDED."updatedAt"`,
        [driverId, vehicle.id, getVehicleMaxSeats(vehicle.type) ?? 4, body.longitude, body.latitude,
          new Date(recordedAt.getTime() + this.positionSeconds * 1000), randomUUID(), recordedAt]);
    });
    return this.status(driverId);
  }

  async registerNotifications(userId: string, version = 1) {
    // The bundled ringtone also serves bookings and passengers, independently of dispatch allocation.
    const user = await this.db.getRepository(User).findOne({ where: { id: userId }, select: ['id', 'fcmToken'] });
    if (!user?.fcmToken) return { registered: false };
    await this.db.query(`INSERT INTO driver_notification_clients ("userId", "tokenHash") VALUES ($1, $2)
      ON CONFLICT ("userId") DO UPDATE SET "tokenHash" = EXCLUDED."tokenHash"`,
      [userId, createHash('sha256').update(user.fcmToken + (version >= 2 ? `:driver-v${version}` : '')).digest('hex')]);
    return { registered: true };
  }

  async setPresence(driverId: string, body: DriverPresenceDto) {
    if (!this.enabled) throw new BadRequestException('Les propositions de proximité ne sont pas encore activées.');
    if (!body.available) {
      await this.db.query(`UPDATE driver_dispatch_presence SET "expiresAt" = now(), "discoveryEnabled" = false WHERE "driverId" = $1`, [driverId]);
      return this.status(driverId);
    }
    await this.db.transaction(async (manager) => {
      const driver = await manager.getRepository(User).findOneBy({ id: driverId });
      if (!driver) throw new NotFoundException('Conducteur introuvable.');
      await assertDriverCanOperate(manager, driver);
      const vehicle = await manager.getRepository(Vehicle).findOneBy({ id: body.vehicleId, ownerId: driverId, isActive: true });
      if (!vehicle || (getVehicleMaxSeats(vehicle.type) ?? 20) < body.seats!)
        throw new BadRequestException('Choisissez un véhicule actif et un nombre de places compatible.');
      if (await this.isBusy(manager, driverId)) throw new ConflictException('Vous avez déjà un trajet ou une commande à prendre en charge.');
      if (body.leaseId) {
        // A late heartbeat must never reactivate an offline/assigned driver or a newer vehicle selection.
        await manager.query(`UPDATE driver_dispatch_presence
          SET position = ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
          "expiresAt" = now() + $5 * interval '1 second', "updatedAt" = now(), "locationReminderSentAt" = NULL,
          "discoveryEnabled" = true
          WHERE "driverId" = $1 AND "leaseId" = $2 AND "discoveryEnabled" IS DISTINCT FROM false
            AND ("discoveryEnabled" = true OR "expiresAt" > now())`,
          [driverId, body.leaseId, body.longitude, body.latitude, this.presenceSeconds]);
        return;
      }
      await manager.query(`INSERT INTO driver_dispatch_presence
        ("driverId", "vehicleId", seats, position, "expiresAt", "leaseId", "discoveryEnabled")
        VALUES ($1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,now() + $6 * interval '1 second', $7,true)
        ON CONFLICT ("driverId") DO UPDATE SET "vehicleId" = EXCLUDED."vehicleId", seats = EXCLUDED.seats,
        position = EXCLUDED.position, "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = now(), "leaseId" = EXCLUDED."leaseId",
        "locationReminderSentAt" = NULL, "discoveryEnabled" = true`,
        [driverId, vehicle.id, body.seats, body.longitude, body.latitude, this.presenceSeconds, randomUUID()]);
    });
    return this.status(driverId);
  }

  private async isBusy(manager: EntityManager, driverId: string, exceptRequestId?: string) {
    const [row] = await manager.query(`SELECT EXISTS (
      SELECT 1 FROM trips WHERE "driverId" = $1::uuid AND
        (status = 'ongoing' OR (status = 'upcoming' AND "departureDate" BETWEEN now() - interval '2 hours' AND now() + interval '30 minutes'))
      UNION ALL SELECT 1 FROM trip_requests WHERE "selectedDriverId" = $1::uuid AND status = 'driver_selected'
        AND "departureDateMax" > now() - interval '2 hours' AND ($2::uuid IS NULL OR id <> $2::uuid)
    ) AS busy`, [driverId, exceptRequestId ?? null]);
    return Boolean(row.busy);
  }

  async getContactDeadline(driverId: string, requestId: string): Promise<Date | null> {
    if (!this.enabled) return null;
    const rows: { expiresAt: Date }[] = await this.db.query(`SELECT o."expiresAt"
      FROM trip_request_dispatch_offers o JOIN trip_requests r ON r.id = o."requestId"
      WHERE o."requestId" = $1 AND o."driverId" = $2 AND o.status = 'pending'
        AND o."expiresAt" > now() AND r.status = 'pending'
        AND r."selectedDriverId" IS NULL AND r."tripId" IS NULL LIMIT 1`, [requestId, driverId]);
    return rows[0] ? new Date(rows[0].expiresAt) : null;
  }

  async getOffer(driverId: string, id: string) {
    const [offer]: DispatchOffer[] = await this.db.query(`SELECT * FROM trip_request_dispatch_offers WHERE id = $1 AND "driverId" = $2`, [id, driverId]);
    if (!offer || offer.status === 'declined') throw new NotFoundException('Proposition introuvable.');
    const request = await this.db.getRepository(TripRequest).findOne({ where: { id: offer.requestId }, relations: ['passenger'] });
    if (!request) throw new NotFoundException('Commande introuvable.');
    assertRequestTarget(request, driverId);
    const vehicle = await this.db.getRepository(Vehicle).findOneBy({ id: offer.vehicleId, ownerId: driverId });
    return { ...offer, serverNow: new Date().toISOString(),
      vehicleName: vehicle ? `${vehicle.brand} ${vehicle.model}` : null,
      actionable: this.enabled && !request.selectedDriverId && !request.tripId &&
        request.departureDateMax.getTime() > Date.now() && request.maxPricePerSeat !== null &&
        dispatchOfferIsActionable(offer.status, offer.expiresAt, request.status),
      request: { id: request.id, passengerName: request.passenger.firstName,
        departure: request.departureLocation, arrival: request.arrivalLocation,
        seats: request.numberOfSeats, pricePerSeat: request.maxPricePerSeat == null ? null : Number(request.maxPricePerSeat),
        paymentMode: request.paymentMode, vehicleType: request.vehicleType },
    };
  }

  async respond(driverId: string, id: string, decision: DispatchDecision) {
    if (!this.enabled) throw new BadRequestException('Les propositions sont désactivées.');
    const [snapshot]: DispatchOffer[] = await this.db.query(`SELECT * FROM trip_request_dispatch_offers WHERE id = $1 AND "driverId" = $2`, [id, driverId]);
    if (!snapshot) throw new NotFoundException('Proposition introuvable.');
    const result = await this.db.transaction(async (manager) => {
      // Same lock order as allocation: request, offer, presence. No network in this transaction.
      const requests = manager.getRepository(TripRequest);
      const request = await requests.findOne({ where: { id: snapshot.requestId }, lock: { mode: 'pessimistic_write' } });
      const [offer]: DispatchOffer[] = await manager.query(`SELECT * FROM trip_request_dispatch_offers WHERE id = $1 FOR UPDATE`, [id]);
      if (request) assertRequestTarget(request, driverId);
      if (request?.sequentialDispatch && !request.immediateDispatch)
        throw new BadRequestException('Ouvrez la commande pour choisir votre véhicule et répondre.');
      const expected = decision === 'accept' ? 'accepted' : 'declined';
      if (request && offer.status === expected && (decision === 'decline' || request.selectedDriverId === driverId))
        return { status: expected, requestId: request.id }; // Retry after a lost response; no repeated side effect.
      if (!request || !dispatchOfferIsActionable(offer.status, offer.expiresAt, request.status) || request.selectedDriverId ||
          request.tripId || request.departureDateMax.getTime() <= Date.now())
        throw new ConflictException('Cette proposition a expiré ou a déjà été traitée.');
      if (decision === 'accept') {
        const [presence] = await manager.query(`SELECT * FROM driver_dispatch_presence WHERE "driverId" = $1 FOR UPDATE`, [driverId]);
        if (!hasUsableDriverLocation(presence) || presence.vehicleId !== offer.vehicleId)
          throw new ConflictException('Votre position ou votre véhicule ne sont plus valides. Rouvrez l’application pour actualiser votre position.');
        const driver = await manager.getRepository(User).findOneBy({ id: driverId });
        if (!driver) throw new NotFoundException('Conducteur introuvable.');
        await assertDriverCanOperate(manager, driver);
        const vehicle = await manager.getRepository(Vehicle).findOneBy({ id: offer.vehicleId, ownerId: driverId, isActive: true });
        if (!vehicle || vehicle.type !== request.vehicleType || offer.seats < request.numberOfSeats ||
            (getVehicleMaxSeats(vehicle.type) ?? 20) < offer.seats || await this.isBusy(manager, driverId, request.id))
          throw new ConflictException('Vous ou votre véhicule ne pouvez plus prendre en charge cette commande.');
        if (request.maxPricePerSeat === null) throw new ConflictException('Le tarif de la commande est indisponible.');
        const offers = manager.getRepository(DriverOffer);
        await offers.save(offers.create({ tripRequestId: request.id, driverId, vehicleId: vehicle.id,
          availableSeats: offer.seats, pricePerSeat: request.maxPricePerSeat,
          proposedDepartureDate: new Date(Math.max(Date.now(), request.departureDateMin.getTime())),
          status: DriverOfferStatus.ACCEPTED, acceptedAt: new Date(), requiresPassengerKyc: false,
          departurePoint: request.departurePoint, arrivalPoint: request.arrivalPoint,
          departureReference: request.departureReference, arrivalReference: request.arrivalReference }));
        const selectedAt = new Date();
        await requests.update(request.id, { status: TripRequestStatus.DRIVER_SELECTED, selectedDriverId: driverId,
          selectedVehicleId: vehicle.id, selectedPricePerSeat: request.maxPricePerSeat,
          selectedDriverRequiresPassengerKyc: false, selectedAt, driverPickupOverdueNotifiedAt: null });
        // First acceptance wins. Every other invitation loses its actionability;
        // queued pushes are revalidated before delivery and retries cannot reassign.
        await manager.query(`UPDATE trip_request_dispatch_offers SET status = 'cancelled'
          WHERE "requestId" = $1 AND id <> $2 AND status = 'pending'`, [request.id, id]);
        await manager.query(`UPDATE driver_dispatch_presence SET "expiresAt" = now() WHERE "driverId" = $1`, [driverId]);
        await enqueueTransactionalNotification(manager, { eventKey: `dispatch-accepted:${id}`, userId: request.passengerId,
          title: 'Conducteur trouvé', body: 'Un conducteur a accepté votre commande. Consultez les détails de la prise en charge.',
          data: { type: 'trip_request_accepted', tripRequestId: request.id, driverId, selectedAt: selectedAt.toISOString() } });
      }
      await manager.query(`UPDATE trip_request_dispatch_offers SET status = $2 WHERE id = $1`, [id, expected]);
      // Commit the refusal and its successor's durable invitation together. Do
      // not depend on the global cron's busy flag or its 25-request batch.
      if (decision === 'decline') {
        await recordRequestRefusal(manager, driverId, request.id);
        if (!this.sequential) await this.allocateNext(manager, request);
      }
      return { status: expected, requestId: request.id };
    });
    // The existing urgent lane sends the committed push immediately when a
    // worker is free; its cron retries delivery without keeping HTTP/DB locks.
    this.rideChanges?.enqueue({ kind: 'request', id: result.requestId, terminal: decision === 'accept' });
    await this.sequential?.advance(result.requestId);
    void this.notifications.dispatchUrgentNotifications()
      .catch(() => this.logger.warn('Dispatch response push delivery deferred.'));
    return result;
  }

  @Cron('*/5 * * * * *')
  async tick(): Promise<void> {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      // Release deadlines even if no driver is currently available; batches remain bounded.
      await this.db.query(`UPDATE trip_request_dispatch_offers SET status = 'expired' WHERE sequential = false AND id IN
        (SELECT id FROM trip_request_dispatch_offers WHERE status = 'pending' AND "expiresAt" <= now()
          ORDER BY "expiresAt", id LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      const leaseId = randomUUID();
      const requests: { id: string; immediateDispatch: boolean }[] = await this.db.query(`WITH candidates AS (
        SELECT r.id FROM trip_requests r
        WHERE r.status IN ('pending', 'offers_received') AND r."departureDateMax" > now()
          AND r."selectedDriverId" IS NULL AND r."tripId" IS NULL AND r."departurePoint" IS NOT NULL
          AND (r."immediateDispatch" = false OR (r.status = 'pending' AND r."maxPricePerSeat" IS NOT NULL))
          AND (r."dispatchClaimedUntil" IS NULL OR r."dispatchClaimedUntil" <= now())
        ORDER BY r."dispatchCheckedAt" NULLS FIRST, r."createdAt", r.id LIMIT 25 FOR UPDATE SKIP LOCKED
      ), claimed AS (
        UPDATE trip_requests r SET "dispatchLeaseId" = $1, "dispatchClaimedUntil" = now() + interval '10 seconds',
          "dispatchCheckedAt" = now() FROM candidates c WHERE r.id = c.id RETURNING r.id, r."immediateDispatch"
      ) SELECT * FROM claimed`, [leaseId]);
      // Small bounded concurrency: preserve pool capacity for acceptance and GPS.
      // A bad request must neither abort the batch nor monopolise its next turn.
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, requests.length) }, async () => {
        while (next < requests.length) {
          const request = requests[next++];
          try {
            if (this.sequential) await this.sequential.poll(request.id);
            else if (request.immediateDispatch) await this.allocate(request.id);
            else await this.db.transaction(manager => enqueueScheduledRequestAlert(
              manager, request.id, this.radiusMeters, driverId => this.isBusy(manager, driverId)));
            await this.db.transaction(manager => enqueueSharedTripAlert(manager, request.id));
          } catch (error) {
            this.logger.warn(`Dispatch request deferred id=${request.id}: ${error instanceof Error ? error.message : 'database error'}`);
            try {
              await this.db.query(`UPDATE trip_requests SET "dispatchCheckedAt" = now() WHERE id = $1`, [request.id]);
            } catch { /* Database outage: leave state intact for the next cycle. */ }
          } finally {
            try {
              await this.db.query(`UPDATE trip_requests SET "dispatchLeaseId" = NULL, "dispatchClaimedUntil" = NULL
                WHERE id = $1 AND "dispatchLeaseId" = $2`, [request.id, leaseId]);
            } catch { /* Lease expires automatically if this worker/database stops. */ }
          }
        }
      }));
      void this.notifications.dispatchTransactionalNotifications().catch(() => this.logger.warn('Dispatch push delivery deferred.'));
    } catch (error) {
      this.logger.error('Driver dispatch cycle failed', error instanceof Error ? error.stack : undefined);
    } finally { this.ticking = false; }
  }

  @Cron('0 */5 * * * *')
  async remindStaleLocations(): Promise<void> {
    if (!this.enabled) return;
    try {
      const count = await this.db.transaction(manager => enqueueStaleLocationReminders(manager));
      if (count) await this.notifications.dispatchTransactionalNotifications();
    } catch {
      this.logger.warn('Driver location reminder deferred.');
    }
  }

  // No age-based presence cleanup: retain one last-known point per driver.
  // Existing foreign keys still remove it when its user/vehicle is deleted.

  private async allocate(requestId: string) {
    await this.db.transaction(async (manager) => {
      const request = await manager.getRepository(TripRequest).createQueryBuilder('r')
        .where('r.id = :requestId AND r.immediateDispatch = true AND r.status = :status', { requestId, status: TripRequestStatus.PENDING })
        .andWhere('r.departureDateMax > NOW()').setLock('pessimistic_write').setOnLocked('skip_locked').getOne();
      if (request) await this.allocateNext(manager, request);
    });
  }

  /** Caller holds the request lock. One live invitation, nearest eligible driver first. */
  private async allocateNext(manager: EntityManager, request: TripRequest): Promise<void> {
    if (!request.immediateDispatch || request.status !== TripRequestStatus.PENDING || !request.departurePoint || request.maxPricePerSeat == null ||
        request.selectedDriverId || request.tripId || request.departureDateMax.getTime() <= Date.now()) return;
    const requestId = request.id;
    // Dispatch scheduling is not a user edit. Keep the form's optimistic version stable.
    await manager.getRepository(TripRequest).update(request.id, { dispatchCheckedAt: new Date(), updatedAt: () => '"updatedAt"' });
    await manager.query(`UPDATE trip_request_dispatch_offers SET status = 'expired'
      WHERE "requestId" = $1 AND status = 'pending' AND "expiresAt" <= now()`, [requestId]);
    type Candidate = { driverId: string; vehicleId: string; seats: number; brand: string; model: string };
    // Lock eligible presences before creating a bounded broadcast. Other requests
    // skip these rows; acceptance still serializes on this request's row lock.
    const selected: Candidate[] = await manager.query(`WITH candidates AS MATERIALIZED (
      SELECT p."driverId", p.xmin AS "presenceVersion", v.id AS "vehicleId", v.brand, v.model,
        ST_Distance(p.position, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography) AS distance,
        CASE WHEN v.id = p."vehicleId" THEN p.seats
        WHEN v.type = 'motorcycle_2_wheels' THEN 2 WHEN v.type = 'motorcycle_3_wheels' THEN 3 ELSE 4 END AS seats
      FROM driver_dispatch_presence p
      JOIN LATERAL (SELECT v.* FROM vehicles v WHERE v."ownerId" = p."driverId"
        AND v."isActive" = true AND v.type = $2
        ORDER BY (v.id = p."vehicleId") DESC, v."updatedAt" DESC, v.id LIMIT 1) v ON true
      WHERE ${USABLE_DRIVER_LOCATION_SQL} AND p."driverId" <> $1::uuid
      AND (CASE WHEN v.id = p."vehicleId" THEN p.seats WHEN v.type = 'motorcycle_2_wheels' THEN 2
        WHEN v.type = 'motorcycle_3_wheels' THEN 3 ELSE 4 END) >= $3
      AND (EXISTS (SELECT 1 FROM trip_requests target WHERE target.id = $7 AND target."targetDriverId" = p."driverId")
        OR ST_DWithin(p.position, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, $6))
      AND ${requestDriverVisibilitySql('$7', 'p."driverId"')}
      AND ${ELIGIBLE_NEARBY_DRIVER_SQL}
      AND NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o
        WHERE o."requestId" = $7 AND o."driverId" = p."driverId")
      AND NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o
        WHERE o."driverId" = p."driverId" AND o.status = 'pending')
      ) SELECT c."driverId", c."vehicleId", c.brand, c.model, c.seats FROM candidates c
      JOIN driver_dispatch_presence locked ON locked."driverId" = c."driverId" AND locked.xmin = c."presenceVersion"
      ORDER BY c.distance, c."driverId" LIMIT 50 FOR UPDATE OF locked SKIP LOCKED`, [request.passengerId, request.vehicleType, request.numberOfSeats,
      request.departurePoint.coordinates[0], request.departurePoint.coordinates[1], this.radiusMeters, requestId]);
    if (!selected.length) return;
    // A READ COMMITTED selection snapshot can precede another allocation's
    // commit. Re-read pending offers after locking the presence rows.
    const occupied: { driverId: string }[] = await manager.query(`SELECT "driverId" FROM trip_request_dispatch_offers
      WHERE "driverId" = ANY($1::uuid[]) AND status = 'pending'`, [selected.map(x => x.driverId)]);
    const busy = new Set(occupied.map(x => x.driverId));
    const offers = selected.filter(x => !busy.has(x.driverId)).map(x => ({ ...x, id: randomUUID() }));
    if (!offers.length) return;
    const expiresAt = new Date(Math.min(Date.now() + this.responseSeconds * 1000, request.departureDateMax.getTime()));
    if (expiresAt.getTime() <= Date.now()) return;
    await manager.query(`UPDATE driver_dispatch_presence p SET "vehicleId" = v.vehicle, seats = v.seats
      FROM unnest($1::uuid[], $2::uuid[], $3::int[]) AS v(driver, vehicle, seats) WHERE p."driverId" = v.driver`,
      [offers.map(x => x.driverId), offers.map(x => x.vehicleId), offers.map(x => x.seats)]);
    await manager.query(`INSERT INTO trip_request_dispatch_offers (id,"requestId","driverId","vehicleId",seats,"expiresAt")
      SELECT v.id,$1,v.driver,v.vehicle,v.seats,$2 FROM unnest($3::uuid[],$4::uuid[],$5::uuid[],$6::int[]) AS v(id,driver,vehicle,seats)`,
      [requestId, expiresAt, offers.map(x => x.id), offers.map(x => x.driverId), offers.map(x => x.vehicleId), offers.map(x => x.seats)]);
    await enqueueTransactionalNotifications(manager, offers.map(offer => ({
      eventKey: `dispatch-offer:${offer.id}`, userId: offer.driverId,
      title: 'Commande de trajet à proximité',
      body: `${request.departureLocation} → ${request.arrivalLocation} · ${request.numberOfSeats} place(s) · ${request.maxPricePerSeat} FC/place · ${offer.brand} ${offer.model}. Accepter ou refuser ?`,
      data: { type: 'driver_dispatch_offer', offerId: offer.id, tripRequestId: requestId, driverId: offer.driverId, passengerId: request.passengerId,
        ...rideSpeechData({ departure: request.departureLocation, arrival: request.arrivalLocation,
          seats: request.numberOfSeats, departureAt: request.departureDateMin,
          pricePerSeat: request.maxPricePerSeat, priceKind: 'budget' }),
        expiresAt: expiresAt.toISOString(), role: 'driver' },
    })));
  }
}
