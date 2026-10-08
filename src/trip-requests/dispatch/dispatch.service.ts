import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
import { enqueueTransactionalNotification } from '../../notifications/transactional-notification';
import { DriverPositionDto, DriverPresenceDto } from './dispatch.dto';
import { boundedInteger, DispatchDecision, dispatchOfferIsActionable } from './dispatch-policy';

interface DispatchOffer {
  id: string; requestId: string; driverId: string; vehicleId: string;
  seats: number; status: string; expiresAt: Date;
}

@Injectable()
export class DriverDispatchService {
  private readonly logger = new Logger(DriverDispatchService.name);
  private ticking = false;
  constructor(private readonly db: DataSource, private readonly config: ConfigService,
    private readonly notifications: NotificationService) {}

  get enabled() { return this.config.get<string>('DRIVER_DISPATCH_ENABLED') === 'true'; }
  private get responseSeconds() { return boundedInteger(this.config.get('DRIVER_DISPATCH_RESPONSE_SECONDS'), 30, 10, 120); }
  private get presenceSeconds() { return boundedInteger(this.config.get('DRIVER_DISPATCH_PRESENCE_SECONDS'), 90, 45, 180); }
  private get radiusMeters() { return boundedInteger(this.config.get('DRIVER_DISPATCH_RADIUS_METERS'), 5000, 500, 20000); }
  private get positionSeconds() { return boundedInteger(this.config.get('DRIVER_DISPATCH_POSITION_SECONDS'), 300, 60, 900); }

  async status(driverId: string) {
    if (!this.enabled) return { enabled: false, available: false, pendingOfferId: null };
    const [presence] = await this.db.query(`SELECT "vehicleId", "leaseId", seats, "expiresAt"
      FROM driver_dispatch_presence WHERE "driverId" = $1 AND "expiresAt" > now()`, [driverId]);
    const [offer] = await this.db.query(`SELECT o.id FROM trip_request_dispatch_offers o
      JOIN trip_requests r ON r.id = o."requestId"
      WHERE o."driverId" = $1 AND o.status = 'pending' AND o."expiresAt" > now()
      AND r.status = 'pending' LIMIT 1`, [driverId]);
    return { enabled: true, available: Boolean(presence), presence: presence ?? null,
      pendingOfferId: offer?.id ?? null, responseSeconds: this.responseSeconds,
      automatic: true, positionFreshSeconds: this.positionSeconds };
  }

  /** A recent GPS fix is enough; no product-level availability/vehicle confirmation. */
  async recordPosition(driverId: string, body: DriverPositionDto) {
    if (!this.enabled) return this.status(driverId);
    const recordedAt = new Date(body.recordedAt);
    const age = Date.now() - recordedAt.getTime();
    if (!Number.isFinite(age) || age < -5000 || age > 30000)
      throw new BadRequestException('La position est trop ancienne.');
    await this.db.transaction(async manager => {
      const driver = await manager.getRepository(User).findOneBy({ id: driverId });
      if (!driver) throw new NotFoundException('Conducteur introuvable.');
      await assertDriverCanOperate(manager, driver);
      const [previous] = await manager.query('SELECT * FROM driver_dispatch_presence WHERE "driverId" = $1 FOR UPDATE', [driverId]);
      if (await this.isBusy(manager, driverId)) return;
      // Preserve the proposed vehicle while an invitation is awaiting a reply.
      const vehicle = (previous && await manager.getRepository(Vehicle).findOneBy({
        id: previous.vehicleId, ownerId: driverId, isActive: true,
      })) || await manager.getRepository(Vehicle).findOne({ where: { ownerId: driverId, isActive: true }, order: { updatedAt: 'DESC', id: 'ASC' } });
      if (!vehicle) return;
      await manager.query(`INSERT INTO driver_dispatch_presence
        ("driverId", "vehicleId", seats, position, "expiresAt", "leaseId", "updatedAt")
        VALUES ($1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,$6,$7,$8)
        ON CONFLICT ("driverId") DO UPDATE SET "vehicleId" = EXCLUDED."vehicleId", seats = EXCLUDED.seats,
          position = EXCLUDED.position, "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = EXCLUDED."updatedAt"
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
      [userId, createHash('sha256').update(user.fcmToken + (version === 2 ? ':driver-v2' : '')).digest('hex')]);
    return { registered: true };
  }

  async setPresence(driverId: string, body: DriverPresenceDto) {
    if (!this.enabled) throw new BadRequestException('Les propositions de proximité ne sont pas encore activées.');
    if (!body.available) {
      await this.db.query(`UPDATE driver_dispatch_presence SET "expiresAt" = now() WHERE "driverId" = $1`, [driverId]);
      return this.status(driverId);
    }
    await this.db.transaction(async (manager) => {
      const driver = await manager.getRepository(User).findOneBy({ id: driverId });
      if (!driver) throw new NotFoundException('Conducteur introuvable.');
      await assertDriverCanOperate(manager, driver);
      const vehicle = await manager.getRepository(Vehicle).findOneBy({ id: body.vehicleId, ownerId: driverId, isActive: true });
      if (!vehicle || (getVehicleMaxSeats(vehicle.type) ?? 20) < body.seats!)
        throw new BadRequestException('Choisissez un véhicule actif et un nombre de places compatible.');
      if (await this.isBusy(manager, driverId)) throw new ConflictException('Vous avez déjà un trajet ou une demande à prendre en charge.');
      if (body.leaseId) {
        // A late heartbeat must never reactivate an offline/assigned driver or a newer vehicle selection.
        await manager.query(`UPDATE driver_dispatch_presence
          SET position = ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
          "expiresAt" = now() + $5 * interval '1 second', "updatedAt" = now()
          WHERE "driverId" = $1 AND "leaseId" = $2 AND "expiresAt" > now()`,
          [driverId, body.leaseId, body.longitude, body.latitude, this.presenceSeconds]);
        return;
      }
      await manager.query(`INSERT INTO driver_dispatch_presence
        ("driverId", "vehicleId", seats, position, "expiresAt", "leaseId")
        VALUES ($1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,now() + $6 * interval '1 second', $7)
        ON CONFLICT ("driverId") DO UPDATE SET "vehicleId" = EXCLUDED."vehicleId", seats = EXCLUDED.seats,
        position = EXCLUDED.position, "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = now(), "leaseId" = EXCLUDED."leaseId"`,
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
    if (!offer) throw new NotFoundException('Proposition introuvable.');
    const request = await this.db.getRepository(TripRequest).findOne({ where: { id: offer.requestId }, relations: ['passenger'] });
    if (!request) throw new NotFoundException('Demande introuvable.');
    const vehicle = await this.db.getRepository(Vehicle).findOneBy({ id: offer.vehicleId, ownerId: driverId });
    return { ...offer, serverNow: new Date().toISOString(),
      vehicleName: vehicle ? `${vehicle.brand} ${vehicle.model}` : null,
      actionable: this.enabled && dispatchOfferIsActionable(offer.status, offer.expiresAt, request.status),
      request: { id: request.id, passengerName: request.passenger.firstName,
        departure: request.departureLocation, arrival: request.arrivalLocation,
        seats: request.numberOfSeats, pricePerSeat: Number(request.maxPricePerSeat ?? 0),
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
      const expected = decision === 'accept' ? 'accepted' : 'declined';
      if (request && offer.status === expected && (decision === 'decline' || request.selectedDriverId === driverId))
        return { status: expected, requestId: request.id }; // Retry after a lost response; no repeated side effect.
      if (!request || !dispatchOfferIsActionable(offer.status, offer.expiresAt, request.status) || request.selectedDriverId)
        throw new ConflictException('Cette proposition a expiré ou a déjà été traitée.');
      if (decision === 'accept') {
        const [presence] = await manager.query(`SELECT * FROM driver_dispatch_presence WHERE "driverId" = $1 FOR UPDATE`, [driverId]);
        if (!presence || new Date(presence.expiresAt).getTime() <= Date.now() || presence.vehicleId !== offer.vehicleId)
          throw new ConflictException('Votre position ou votre véhicule ne sont plus valides. Rouvrez l’application pour actualiser votre position.');
        const driver = await manager.getRepository(User).findOneBy({ id: driverId });
        if (!driver) throw new NotFoundException('Conducteur introuvable.');
        await assertDriverCanOperate(manager, driver);
        const vehicle = await manager.getRepository(Vehicle).findOneBy({ id: offer.vehicleId, ownerId: driverId, isActive: true });
        if (!vehicle || vehicle.type !== request.vehicleType || offer.seats < request.numberOfSeats ||
            (getVehicleMaxSeats(vehicle.type) ?? 20) < offer.seats || await this.isBusy(manager, driverId, request.id))
          throw new ConflictException('Vous ou votre véhicule ne pouvez plus prendre en charge cette demande.');
        if (request.maxPricePerSeat === null) throw new ConflictException('Le tarif de la demande est indisponible.');
        const offers = manager.getRepository(DriverOffer);
        await offers.save(offers.create({ tripRequestId: request.id, driverId, vehicleId: vehicle.id,
          availableSeats: offer.seats, pricePerSeat: request.maxPricePerSeat,
          proposedDepartureDate: new Date(Math.max(Date.now(), request.departureDateMin.getTime())),
          status: DriverOfferStatus.ACCEPTED, acceptedAt: new Date(), requiresPassengerKyc: false,
          departurePoint: request.departurePoint, arrivalPoint: request.arrivalPoint,
          departureReference: request.departureReference, arrivalReference: request.arrivalReference }));
        await requests.update(request.id, { status: TripRequestStatus.DRIVER_SELECTED, selectedDriverId: driverId,
          selectedVehicleId: vehicle.id, selectedPricePerSeat: request.maxPricePerSeat,
          selectedDriverRequiresPassengerKyc: false, selectedAt: new Date(), driverPickupOverdueNotifiedAt: null });
        await manager.query(`UPDATE driver_dispatch_presence SET "expiresAt" = now() WHERE "driverId" = $1`, [driverId]);
        await enqueueTransactionalNotification(manager, { eventKey: `dispatch-accepted:${id}`, userId: request.passengerId,
          title: 'Conducteur trouvé', body: 'Un conducteur a accepté votre demande. Consultez les détails de la prise en charge.',
          data: { type: 'trip_request_accepted', tripRequestId: request.id, driverId } });
      }
      await manager.query(`UPDATE trip_request_dispatch_offers SET status = $2 WHERE id = $1`, [id, expected]);
      return { status: expected, requestId: request.id };
    });
    void this.tick();
    return result;
  }

  @Cron('*/5 * * * * *')
  async tick(): Promise<void> {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      // Release deadlines even if no driver is currently available; batches remain bounded.
      await this.db.query(`UPDATE trip_request_dispatch_offers SET status = 'expired' WHERE id IN
        (SELECT id FROM trip_request_dispatch_offers WHERE status = 'pending' AND "expiresAt" <= now() LIMIT 100)`);
      const requests: { id: string }[] = await this.db.query(`SELECT r.id FROM trip_requests r
        WHERE r."immediateDispatch" = true AND r.status = 'pending' AND r."departureDateMax" > now()
        AND NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o WHERE o."requestId" = r.id AND o.status = 'pending')
        ORDER BY r."dispatchCheckedAt" NULLS FIRST, r."createdAt" LIMIT 25`);
      for (const request of requests) await this.allocate(request.id);
      void this.notifications.dispatchTransactionalNotifications().catch(() => this.logger.warn('Dispatch push delivery deferred.'));
    } catch (error) {
      this.logger.error('Driver dispatch cycle failed', error instanceof Error ? error.stack : undefined);
    } finally { this.ticking = false; }
  }

  @Cron('0 0 * * * *')
  async prunePresence(): Promise<void> {
    if (!this.enabled) return;
    // Bounded hourly retention cleanup; the five-second allocation loop does not scan old GPS rows.
    await this.db.query(`DELETE FROM driver_dispatch_presence WHERE "driverId" IN
      (SELECT "driverId" FROM driver_dispatch_presence WHERE "expiresAt" < now() - interval '1 day' LIMIT 1000)`);
  }

  private async allocate(requestId: string) {
    await this.db.transaction(async (manager) => {
      const request = await manager.getRepository(TripRequest).createQueryBuilder('r')
        .where('r.id = :requestId AND r.immediateDispatch = true AND r.status = :status', { requestId, status: TripRequestStatus.PENDING })
        .andWhere('r.departureDateMax > NOW()').setLock('pessimistic_write').setOnLocked('skip_locked').getOne();
      if (!request || !request.departurePoint) return;
      await manager.getRepository(TripRequest).update(request.id, { dispatchCheckedAt: new Date() });
      const [pending] = await manager.query(`SELECT id FROM trip_request_dispatch_offers WHERE "requestId" = $1 AND status = 'pending'`, [requestId]);
      if (pending) return;
      const candidates: { driverId: string; vehicleId: string; seats: number }[] = await manager.query(`
        SELECT p."driverId", v.id AS "vehicleId", CASE WHEN v.id = p."vehicleId" THEN p.seats
          WHEN v.type = 'motorcycle_2_wheels' THEN 2 WHEN v.type = 'motorcycle_3_wheels' THEN 3 ELSE 4 END AS seats
        FROM driver_dispatch_presence p
        JOIN LATERAL (SELECT v.* FROM vehicles v WHERE v."ownerId" = p."driverId"
          AND v."isActive" = true AND v.type = $2
          ORDER BY (v.id = p."vehicleId") DESC, v."updatedAt" DESC, v.id LIMIT 1) v ON true
        WHERE p."expiresAt" > now() + $8 * interval '1 second' AND p."driverId" <> $1::uuid
        AND (CASE WHEN v.id = p."vehicleId" THEN p.seats WHEN v.type = 'motorcycle_2_wheels' THEN 2
          WHEN v.type = 'motorcycle_3_wheels' THEN 3 ELSE 4 END) >= $3
        AND ST_DWithin(p.position, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, $6)
        AND NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o WHERE
          (o."requestId" = $7 AND o."driverId" = p."driverId") OR (o."driverId" = p."driverId" AND o.status = 'pending'))
        ORDER BY ST_Distance(p.position, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography), p."driverId"
        LIMIT 20 FOR UPDATE OF p SKIP LOCKED`, [request.passengerId, request.vehicleType, request.numberOfSeats,
        request.departurePoint.coordinates[0], request.departurePoint.coordinates[1], this.radiusMeters, requestId, this.responseSeconds + 5]);
      for (const candidate of candidates) {
        const driver = await manager.getRepository(User).findOneBy({ id: candidate.driverId });
        if (!driver?.fcmToken || await this.isBusy(manager, candidate.driverId)) continue;
        try { await assertDriverCanOperate(manager, driver); } catch (error) {
          if (error instanceof BadRequestException || (error as { status?: number }).status === 403) continue;
          throw error;
        }
        const [capability] = await manager.query(`SELECT 1 FROM driver_notification_clients WHERE "userId" = $1 AND "tokenHash" IN ($2,$3)`,
          [driver.id, createHash('sha256').update(driver.fcmToken).digest('hex'),
            createHash('sha256').update(driver.fcmToken + ':driver-v2').digest('hex')]);
        if (!capability) continue;
        const id = randomUUID();
        const vehicle = await manager.getRepository(Vehicle).findOneByOrFail({ id: candidate.vehicleId, ownerId: driver.id });
        await manager.query('UPDATE driver_dispatch_presence SET "vehicleId" = $2, seats = $3 WHERE "driverId" = $1',
          [driver.id, candidate.vehicleId, candidate.seats]);
        const expiresAt = new Date(Math.min(Date.now() + this.responseSeconds * 1000, request.departureDateMax.getTime()));
        await manager.query(`INSERT INTO trip_request_dispatch_offers (id,"requestId","driverId","vehicleId",seats,"expiresAt")
          VALUES ($1,$2,$3,$4,$5,$6)`, [id, requestId, driver.id, candidate.vehicleId, candidate.seats, expiresAt]);
        await enqueueTransactionalNotification(manager, { eventKey: `dispatch-offer:${id}`, userId: driver.id,
          title: 'Demande de trajet à proximité', body: `${request.departureLocation} → ${request.arrivalLocation} · ${request.numberOfSeats} place(s) · ${request.maxPricePerSeat} FC/place · ${vehicle.brand} ${vehicle.model}. Accepter ou refuser ?`,
          data: { type: 'driver_dispatch_offer', offerId: id, tripRequestId: requestId, driverId: driver.id,
            expiresAt: expiresAt.toISOString(), role: 'driver' } });
        return;
      }
    });
  }
}
