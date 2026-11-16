import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  SaveZoneDto,
  UpdateZoneDto,
  ZonePageDto,
  ZoneSettingsDto,
} from './zones.dto';
import { normalizeZoneGeometry } from './zones.policy';

const zoneProjection = `id,name,description,active,priority,version,"createdAt","updatedAt",ST_AsGeoJSON(boundary)::json AS geometry`;

@Injectable()
export class ZonesService {
  constructor(private readonly db: DataSource) {}
  async status(em: EntityManager = this.db.manager, lock = false) {
    const [row] = await em.query(`SELECT to_regclass('public.zones') IS NOT NULL
      AND to_regclass('public.zone_settings') IS NOT NULL AS ready`);
    if (!row.ready)
      return { enabled: false, ready: false, mode: 'observe', version: null };
    const [settings] = await em.query(
      `SELECT enabled,version FROM zone_settings WHERE id=true${lock ? ' FOR SHARE' : ''}`,
    );
    return {
      enabled: settings?.enabled ?? false,
      ready: !!settings,
      mode: 'observe',
      version: settings?.version ?? null,
    };
  }
  private async assertReady(em: EntityManager) {
    if (!(await this.status(em)).ready)
      throw new ServiceUnavailableException(
        'Appliquer les migrations OperationalZones et ZoneRuntimeSettings.',
      );
  }
  async updateSettings(actor: string, dto: ZoneSettingsDto) {
    return this.db.transaction(async (em) => {
      await em.query("SET LOCAL statement_timeout='5s'");
      await em.query("SET LOCAL lock_timeout='4s'");
      await this.assertReady(em);
      const [current] = await em.query(
        'SELECT enabled,version FROM zone_settings WHERE id=true FOR UPDATE',
      );
      if (current.version !== dto.version)
        throw new ConflictException(
          'Réglage modifié par un autre administrateur. Actualisez la page.',
        );
      if (current.enabled === dto.enabled)
        return { ...current, ready: true, mode: 'observe' };
      await em.query(
        'UPDATE zone_settings SET enabled=$1,version=version+1,"updatedAt"=clock_timestamp() WHERE id=true',
        [dto.enabled],
      );
      // Reset observation evidence on either transition, especially after a long pause.
      await em.query(
        'UPDATE zone_catalog SET revision=revision+1,"changedAt"=clock_timestamp() WHERE id=true',
      );
      await em.query(
        'INSERT INTO zone_settings_audit(id,"actorId",enabled,version) VALUES($1,$2,$3,$4)',
        [randomUUID(), actor, dto.enabled, current.version + 1],
      );
      return {
        enabled: dto.enabled,
        version: current.version + 1,
        ready: true,
        mode: 'observe',
      };
    });
  }
  private async read<T>(run: (em: EntityManager) => Promise<T>) {
    return this.db.transaction('REPEATABLE READ', async (em) => {
      await em.query("SET LOCAL statement_timeout='5s'");
      await this.assertReady(em);
      return run(em);
    });
  }
  list(q: ZonePageDto) {
    return this.read(async (em) => {
      const [count] = await em.query(
        'SELECT count(*)::int AS total FROM zones',
      );
      const items = await em.query(
        `SELECT ${zoneProjection} FROM zones ORDER BY name,id LIMIT $1 OFFSET $2`,
        [q.limit, (q.page - 1) * q.limit],
      );
      return { items, total: count.total, page: q.page, limit: q.limit };
    });
  }
  events(q: ZonePageDto) {
    return this.read(async (em) => {
      const [count] = await em.query(
        'SELECT count(*)::int AS total FROM zone_events',
      );
      const items = await em.query(
        'SELECT * FROM zone_events ORDER BY "createdAt" DESC,id LIMIT $1 OFFSET $2',
        [q.limit, (q.page - 1) * q.limit],
      );
      return { items, total: count.total, page: q.page, limit: q.limit };
    });
  }
  assignments(q: ZonePageDto) {
    return this.read(async (em) => {
      const [count] = await em.query(
        'SELECT count(*)::int AS total FROM zone_assignments',
      );
      const items = await em.query(
        `SELECT a.id,a."tripId",a."requestId",a."checkedAt",a.revision,
        a."departureZoneId",a."arrivalZoneId",d.name AS "departureZone",r.name AS "arrivalZone"
        FROM zone_assignments a LEFT JOIN zones d ON d.id=a."departureZoneId"
        LEFT JOIN zones r ON r.id=a."arrivalZoneId" ORDER BY a."checkedAt" DESC,a.id LIMIT $1 OFFSET $2`,
        [q.limit, (q.page - 1) * q.limit],
      );
      return { items, total: count.total, page: q.page, limit: q.limit };
    });
  }
  audit(id: string, q: ZonePageDto) {
    return this.read(async (em) => {
      const [count] = await em.query(
        'SELECT count(*)::int AS total FROM zone_audit_logs WHERE "zoneId"=$1',
        [id],
      );
      const items = await em.query(
        'SELECT id,"zoneId","actorId",version,"createdAt" FROM zone_audit_logs WHERE "zoneId"=$1 ORDER BY version DESC LIMIT $2 OFFSET $3',
        [id, q.limit, (q.page - 1) * q.limit],
      );
      return { items, total: count.total, page: q.page, limit: q.limit };
    });
  }
  async save(actor: string, dto: SaveZoneDto | UpdateZoneDto, id?: string) {
    const geometry = normalizeZoneGeometry(dto.geometry);
    if (dto.name.trim().length < 2)
      throw new BadRequestException('Nom de zone trop court.');
    return this.db.transaction(async (em) => {
      await em.query("SET LOCAL statement_timeout='5s'");
      await em.query("SET LOCAL lock_timeout='2s'");
      await this.assertReady(em);
      const [validation] = await em.query(
        `SELECT ST_IsValid(g) AND NOT ST_IsEmpty(g) AND ST_Area(g::geography)>0 AS valid
        FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),4326) AS g) s`,
        [JSON.stringify(geometry)],
      );
      if (!validation.valid)
        throw new BadRequestException(
          'Polygone invalide : vérifier les intersections et les trous.',
        );
      // Serialize catalog mutations and exclude monitoring under a mixed revision.
      await em.query(
        'UPDATE zone_catalog SET revision=revision+1,"changedAt"=clock_timestamp() WHERE id=true',
      );
      const params = [
        dto.name.trim(),
        dto.description ?? '',
        JSON.stringify(geometry),
        dto.active,
        dto.priority,
      ];
      let row;
      if (id) {
        [row] = await em.query(
          `WITH changed AS (UPDATE zones SET name=$1,description=$2,boundary=ST_SetSRID(ST_GeomFromGeoJSON($3),4326),
          active=$4,priority=$5,version=version+1,"updatedAt"=now() WHERE id=$6 AND version=$7 RETURNING *) SELECT ${zoneProjection} FROM changed`,
          [...params, id, (dto as UpdateZoneDto).version],
        );
        if (!row) {
          const exists = await em.query('SELECT id FROM zones WHERE id=$1', [
            id,
          ]);
          if (!exists.length) throw new NotFoundException('Zone introuvable.');
          throw new ConflictException(
            'Cette zone a été modifiée. Rechargez-la avant de réessayer.',
          );
        }
      } else {
        [row] = await em.query(
          `INSERT INTO zones(name,description,boundary,active,priority,id)
          VALUES($1,$2,ST_SetSRID(ST_GeomFromGeoJSON($3),4326),$4,$5,$6) RETURNING ${zoneProjection}`,
          [...params, randomUUID()],
        );
      }
      await em.query(
        'INSERT INTO zone_audit_logs(id,"zoneId","actorId",version,snapshot) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), row.id, actor, row.version, JSON.stringify(row)],
      );
      return row;
    });
  }
}
