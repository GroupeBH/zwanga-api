import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import type { UpdateDispatchResult } from './app-update-delivery.service';
import {
  CAMPAIGN_AUDIENCE_SQL,
  INSTALLATION_AUDIENCE_SQL,
} from './installation-update.policy';

@Injectable()
export class InstallationUpdateDispatchService {
  private running = false;
  private readonly logger = new Logger(InstallationUpdateDispatchService.name);
  constructor(
    private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}
  @Cron('*/30 * * * * *')
  async enqueue(releaseId?: string): Promise<UpdateDispatchResult> {
    if (this.config.get<string>('APP_UPDATES_ENABLED') !== 'true') return { state: 'disabled', queued: 0 };
    if (this.running) return { state: 'busy', queued: 0 };
    this.running = true;
    let queued = 0;
    try {
      for (const manual of [false, true]) {
        const event = manual
          ? `'installation-message:' || m.id || ':' || c.id`
          : `'installation-update:' || r.id || ':' || c.id`;
        const rows = await this.db
          .query(`INSERT INTO notifications ("eventKey","userId","fcmToken",title,body,data,"isAutomatic",status,"isActive")
          SELECT ${event}, NULL, '', ${manual ? 'm.title' : "'Une mise à jour de Zwanga est disponible'"},
            ${manual ? 'm.body' : "CASE WHEN to_jsonb(r)->>'comparison'='native_build' THEN 'Mettez Zwanga à jour pour profiter des dernières améliorations.' ELSE 'Installez la version ' || r.version || ' pour profiter des dernières améliorations.' END"},
            jsonb_build_object('type','app_update','installationId',c.id::text,'releaseId',r.id::text,'platform',r.platform,
              'version',r.version,'build',r.build,'navigateTo','/app-update') ${manual ? "|| jsonb_build_object('campaignId',m.id::text)" : ''},
            false,'pending',true
          FROM app_update_installations c JOIN app_store_releases r ON r.platform=c.platform
          ${manual ? 'JOIN app_update_campaigns m ON m."releaseId"=r.id' : ''}
          WHERE ${manual ? CAMPAIGN_AUDIENCE_SQL : INSTALLATION_AUDIENCE_SQL} AND ($1::bigint IS NULL OR r.id = $1)
            AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n."eventKey"=${event})
          ORDER BY c.id LIMIT 100 ON CONFLICT ("eventKey") DO NOTHING RETURNING id`, [releaseId ?? null]);
        queued += Array.isArray(rows) ? rows.length : 0;
      }
      return { state: 'prepared', queued };
    } catch {
      this.logger.warn(
        'Annonces aux installations différées ; nouvelle tentative au prochain passage.',
      );
      return { state: 'retry_pending', queued };
    } finally {
      this.running = false;
    }
  }
}
