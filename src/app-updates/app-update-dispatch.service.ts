import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { DataSource, EntityManager } from 'typeorm';
import { UPDATE_CLIENT_ELIGIBLE_SQL } from './app-update.policy';

/** Shared by the initial dispatcher and the existing push retry path. */
export async function isAppUpdateDeliverable(manager: EntityManager, releaseId: unknown, userId: string | null): Promise<boolean> {
  if (typeof releaseId !== 'string' || !/^\d{1,18}$/.test(releaseId) || !userId) return false;
  const rows: unknown[] = await manager.query(`SELECT 1 FROM app_store_releases r
    JOIN app_update_clients c ON c.platform = r.platform JOIN users u ON u.id = c."userId"
    WHERE r.id = $1 AND c."userId" = $2 AND ${UPDATE_CLIENT_ELIGIBLE_SQL}`, [releaseId, userId]);
  return rows.length > 0;
}

@Injectable()
export class AppUpdateDispatchService {
  private readonly logger = new Logger(AppUpdateDispatchService.name);
  private running = false;
  constructor(private readonly db: DataSource, private readonly config: ConfigService) {}
  @Cron('*/30 * * * * *')
  async enqueueUpdates(): Promise<void> {
    if (this.running || this.config.get<string>('APP_UPDATES_ENABLED') !== 'true') return;
    this.running = true;
    try {
      // One bounded statement; unique eventKey handles multiple server processes.
      // The existing outbox sends only after commit, outside this database statement.
      await this.db.query(`INSERT INTO notifications ("eventKey", "userId", "fcmToken", title, body, data, "isAutomatic", status, "isActive")
        SELECT 'app-update:' || r.id || ':' || c."userId", c."userId", '', 'Une mise à jour de Zwanga est disponible',
          'Installez la version ' || r.version || ' pour profiter des dernières améliorations.',
          jsonb_build_object('type','app_update','releaseId',r.id::text,'platform',r.platform,'version',r.version,'build',r.build,'navigateTo','/app-update'),
          false, 'pending', true
        FROM app_store_releases r JOIN app_update_clients c ON c.platform = r.platform JOIN users u ON u.id = c."userId"
        WHERE ${UPDATE_CLIENT_ELIGIBLE_SQL}
          AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n."eventKey" = 'app-update:' || r.id || ':' || c."userId")
        ORDER BY c."userId" LIMIT 100 ON CONFLICT ("eventKey") DO NOTHING`);
    } catch { this.logger.warn('Impossible de préparer les annonces de mise à jour ; nouvelle tentative au prochain passage.'); }
    finally { this.running = false; }
  }
}
