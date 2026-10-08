import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AppUpdateClientDto, AppVersionDto, PublishAppReleaseDto } from './app-update.dto';
import { AppRelease, normalizeAppVersion, UPDATE_REQUIRED_SQL } from './app-update.policy';
import { createHash } from 'crypto';

@Injectable()
export class AppUpdatesService {
  constructor(private readonly db: DataSource, private readonly config: ConfigService) {}
  enabled() { return this.config.get<string>('APP_UPDATES_ENABLED') === 'true'; }
  private requireEnabled() {
    if (!this.enabled()) throw new ServiceUnavailableException('Les annonces de mise à jour ne sont pas encore activées.');
  }
  private normalize(input: AppVersionDto) {
    const version = normalizeAppVersion(input.version), build = normalizeAppVersion(input.build);
    if (!version || !build) throw new BadRequestException('Version ou numéro de build invalide.');
    return { ...input, version, build };
  }
  async latest(input: AppVersionDto): Promise<{ enabled: boolean; release: AppRelease | null }> {
    if (!this.enabled()) return { enabled: false, release: null };
    const value = this.normalize(input);
    const rows: AppRelease[] = await this.db.query(`SELECT r.id, r.platform, r.version, r.build, r.notes, r.available, r."publishedAt" FROM app_store_releases r
      CROSS JOIN (SELECT $2::text AS version, $3::text AS build) c
      WHERE r.available = true AND r.platform = $1 AND ${UPDATE_REQUIRED_SQL} LIMIT 1`,
      [value.platform, value.version, value.build]);
    return { enabled: true, release: rows[0] ?? null };
  }
  async register(userId: string, input: AppUpdateClientDto) {
    this.requireEnabled();
    const value = this.normalize(input);
    // Do not bind a device version to a different device's current push token.
    // A missing/rejected push permission still permits in-app announcements.
    const rows: { fcmToken: string | null }[] = await this.db.query('SELECT "fcmToken" FROM users WHERE id = $1 AND "isActive" = true', [userId]);
    if (!rows.length) throw new BadRequestException('Compte indisponible.');
    if (input.pushToken && input.pushToken !== rows[0].fcmToken) throw new BadRequestException('Enregistrement des notifications en cours. Réessayez.');
    const hash = input.pushToken ? createHash('sha256').update(input.pushToken).digest('hex') : null;
    await this.db.query(`INSERT INTO app_update_clients ("userId", platform, version, build, "tokenHash") VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT ("userId") DO UPDATE SET platform = EXCLUDED.platform, version = EXCLUDED.version,
      build = EXCLUDED.build, "tokenHash" = EXCLUDED."tokenHash", "updatedAt" = now()`,
      [userId, value.platform, value.version, value.build, hash]);
    return { registered: true };
  }
  async list(): Promise<AppRelease[]> {
    this.requireEnabled();
    return this.db.query('SELECT * FROM app_store_releases ORDER BY id DESC LIMIT 50');
  }
  async publish(adminId: string, input: PublishAppReleaseDto): Promise<AppRelease> {
    this.requireEnabled();
    if (input.storeAvailabilityConfirmed !== true) throw new BadRequestException('Confirmez la disponibilité publique sur le store.');
    const value = this.normalize(input);
    return this.db.transaction(async manager => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`app-update:${value.platform}`]);
      // Repeating the same announcement must not reactivate an old/retracted release or duplicate pushes.
      const existing: AppRelease[] = await manager.query('SELECT * FROM app_store_releases WHERE platform = $1 AND version = $2 AND build = $3',
        [value.platform, value.version, value.build]);
      if (existing[0]) return existing[0];
      const newer: AppRelease[] = await manager.query(`SELECT * FROM app_store_releases WHERE platform = $1
        AND (string_to_array(version, '.')::int[] > string_to_array($2, '.')::int[]
        OR (version = $2 AND string_to_array(build, '.')::int[] >= string_to_array($3, '.')::int[])) LIMIT 1`,
        [value.platform, value.version, value.build]);
      if (newer.length) throw new BadRequestException('Une version plus récente a déjà été annoncée.');
      await manager.query('UPDATE app_store_releases SET available = false WHERE platform = $1 AND available = true', [value.platform]);
      const rows: AppRelease[] = await manager.query(`INSERT INTO app_store_releases (platform, version, build, notes, "publishedBy")
        VALUES ($1,$2,$3,$4,$5) RETURNING *`, [value.platform, value.version, value.build, input.notes.trim(), adminId]);
      return rows[0];
    });
  }
  async withdraw(id: string) {
    this.requireEnabled();
    await this.db.query('UPDATE app_store_releases SET available = false WHERE id = $1', [id]);
    return { withdrawn: true };
  }
}
