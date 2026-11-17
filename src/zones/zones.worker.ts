import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import { LocationHistoryService } from '../common/services/location-history.service';
import {
  advanceZoneMonitor,
  usableZoneObservation,
  ZoneMonitor,
  ZoneObservation,
} from './zones.policy';
import { ZonesService } from './zones.service';

// No calls from acceptance, payments, dispatch or GPS ingestion. Separate, bounded observer.
@Injectable()
export class ZonesWorker {
  private busy = false;
  private readonly logger = new Logger(ZonesWorker.name);
  constructor(
    private readonly db: DataSource,
    private readonly zones: ZonesService,
    private readonly history: LocationHistoryService,
  ) {}

  @Cron('*/5 * * * * *')
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.db.transaction(async (em) => {
        await em.query("SET LOCAL statement_timeout='3s'");
        await em.query("SET LOCAL lock_timeout='500ms'");
        const [{ locked }] = await em.query(
          'SELECT pg_try_advisory_xact_lock(1780000131) AS locked',
        );
        if (!locked) return;
        const settings = await this.zones.status(em, true);
        if (!settings.ready || !settings.enabled) return;
        const [{ revision, changedAt }] = await em.query(
          'SELECT revision,"changedAt" FROM zone_catalog WHERE id=true FOR SHARE',
        );
        const trips = await this.assign(em, 'trips', 'tripId', revision);
        await this.assign(em, 'trip_requests', 'requestId', revision);
        const [{ covered }] = await em.query(
          'SELECT EXISTS(SELECT 1 FROM zones WHERE active) AS covered',
        );
        if (!covered) return; // No configured coverage is not proof of an incident.
        await this.monitor(
          em,
          trips.filter((t) => t.status === 'ongoing'),
          revision,
          new Date(changedAt).getTime(),
        );
      });
    } catch {
      // Never leak locations/SQL or fail the core trip lifecycle on observer failures.
      this.logger.warn(
        'Zone observation deferred; trips and dispatch remain unaffected.',
      );
    } finally {
      this.busy = false;
    }
  }

  async assign(
    em: EntityManager,
    table: 'trips' | 'trip_requests',
    key: 'tripId' | 'requestId',
    revision: number,
  ) {
    // Table/key originate only from the literal calls above; no user-controlled identifiers.
    const statuses =
      table === 'trips'
        ? "'upcoming','ongoing'"
        : "'pending','offers_received','driver_selected'";
    const live =
      table === 'trips'
        ? `s.status IN (${statuses})`
        : `(s.status IN (${statuses}) AND s."tripId" IS NULL)`;
    return em.query(
      `WITH candidates AS (
      SELECT s.id,s.status,s."departurePoint",s."arrivalPoint" FROM ${table} s
      LEFT JOIN zone_assignments a ON a."${key}"=s.id
      WHERE ((${live}) AND (a.id IS NULL OR a."checkedAt"<now()-interval '15 seconds'))
        OR (s."updatedAt">now()-interval '1 day' AND (a.id IS NULL OR a."checkedAt"<s."updatedAt"))
      ORDER BY a."checkedAt" ASC NULLS FIRST,s.id LIMIT 200
    ), assigned AS (
      INSERT INTO zone_assignments(id,"${key}","departureZoneId","arrivalZoneId",revision)
      SELECT gen_random_uuid(),c.id,d.id,r.id,$1 FROM candidates c
      LEFT JOIN LATERAL (SELECT id FROM zones WHERE active AND ST_Covers(boundary,c."departurePoint"::geometry)
        ORDER BY priority DESC,ST_Area(boundary::geography),id LIMIT 1) d ON true
      LEFT JOIN LATERAL (SELECT id FROM zones WHERE active AND ST_Covers(boundary,c."arrivalPoint"::geometry)
        ORDER BY priority DESC,ST_Area(boundary::geography),id LIMIT 1) r ON true
      ON CONFLICT ("${key}") DO UPDATE SET "departureZoneId"=EXCLUDED."departureZoneId",
        "arrivalZoneId"=EXCLUDED."arrivalZoneId","checkedAt"=now(),revision=EXCLUDED.revision,
        monitor=CASE WHEN zone_assignments.revision=EXCLUDED.revision THEN zone_assignments.monitor ELSE '{}'::jsonb END
      RETURNING *
    ) SELECT a.*,c.status FROM assigned a JOIN candidates c ON c.id=a."${key}"`,
      [revision],
    );
  }

  private async monitor(
    em: EntityManager,
    trips: Array<{ tripId: string; monitor: ZoneMonitor }>,
    revision: number,
    changedAt: number,
  ) {
    const observations: Array<ZoneObservation & { tripId: string }> = [];
    const now = Date.now();
    // Batches of 20, at most 200 trips. A stalled Redis read cannot monopolize the worker.
    for (let i = 0; i < trips.length; i += 20) {
      await Promise.all(
        trips.slice(i, i + 20).map(async (t) => {
          let timer: NodeJS.Timeout | undefined;
          try {
            const snapshot = await Promise.race([
              this.history.getDriverLocationHistory(t.tripId),
              new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), 300);
              }),
            ]);
            const fixes = snapshot?.samples ?? [
              snapshot?.previous,
              snapshot?.current,
            ];
            for (const fix of fixes.slice(-10))
              if (
                fix &&
                usableZoneObservation(fix, now) &&
                Date.parse(fix.recordedAt) >= changedAt
              )
                observations.push({ ...fix, tripId: t.tripId });
          } catch {
            /* No GPS is not evidence of leaving coverage. */
          } finally {
            if (timer) clearTimeout(timer);
          }
        }),
      );
    }
    if (!observations.length) return;
    const classified = await em.query(
      `SELECT p.*,NOT EXISTS(SELECT 1 FROM zones z WHERE z.active AND
      ST_DWithin(z.boundary::geography,ST_SetSRID(ST_MakePoint(p.longitude,p.latitude),4326)::geography,50+p."accuracyMeters")) AS outside
      FROM jsonb_to_recordset($1::jsonb) AS p("tripId" uuid,"recordedAt" text,longitude double precision,latitude double precision,"accuracyMeters" double precision)
      ORDER BY p."tripId",p."recordedAt"::timestamptz`,
      [JSON.stringify(observations)],
    );
    const states = new Map(trips.map((t) => [t.tripId, t.monitor]));
    const events: Array<{
      id: string;
      tripId: string;
      kind: string;
      observedAt: string;
    }> = [];
    for (const fix of classified) {
      const result = advanceZoneMonitor(
        states.get(fix.tripId) ?? {},
        Date.parse(fix.recordedAt),
        fix.outside,
      );
      states.set(fix.tripId, result.state);
      if (result.event)
        events.push({
          id: randomUUID(),
          tripId: fix.tripId,
          kind: result.event,
          observedAt: fix.recordedAt,
        });
    }
    await em.query(
      `UPDATE zone_assignments a SET monitor=p.monitor FROM jsonb_to_recordset($1::jsonb) AS p("tripId" uuid,monitor jsonb)
      WHERE a."tripId"=p."tripId"`,
      [
        JSON.stringify(
          [...states].map(([tripId, monitor]) => ({ tripId, monitor })),
        ),
      ],
    );
    if (events.length)
      await em.query(
        `INSERT INTO zone_events(id,"tripId",kind,"observedAt",revision)
      SELECT p.id,p."tripId",p.kind,p."observedAt",$2 FROM jsonb_to_recordset($1::jsonb) AS p(id uuid,"tripId" uuid,kind text,"observedAt" timestamptz)
      JOIN trips t ON t.id=p."tripId" AND t.status='ongoing'
      ON CONFLICT ("tripId","observedAt",kind) DO NOTHING`,
        [JSON.stringify(events), revision],
      );
  }
}
