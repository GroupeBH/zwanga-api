import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import {
  InstallationUpdateDto,
  UpdateCampaignDto,
} from './installation-update.dto';
import { INSTALLATION_AUDIENCE_SQL } from './installation-update.policy';
import { normalizeAppVersion } from './app-update.policy';

export interface CampaignSummary {
  id: string;
  releaseId: string;
  title: string;
  body: string;
  active: boolean;
  createdAt: Date;
  queued: string;
  sent: string;
}

@Injectable()
export class InstallationUpdatesService {
  constructor(
    private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}
  private available() {
    if (this.config.get<string>('APP_UPDATES_ENABLED') !== 'true')
      throw new ServiceUnavailableException(
        'Les annonces de mise à jour ne sont pas activées.',
      );
  }
  async register(
    id: string,
    secret: string | undefined,
    input: InstallationUpdateDto,
  ) {
    if (!secret || !/^[a-zA-Z0-9_-]{64,128}$/.test(secret))
      throw new ForbiddenException('Installation non reconnue.');
    const version = normalizeAppVersion(input.version),
      build = normalizeAppVersion(input.build);
    if (!version || !build || (input.enabled && !input.pushToken?.trim()))
      throw new BadRequestException(
        'Informations de notification incomplètes.',
      );
    const hash = (text: string) =>
      createHash('sha256').update(text).digest('hex');
    const token = input.pushToken?.trim() || null;
    return this.db.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`installation:${id}`],
      );
      const current: {
        secretHash: string;
        tokenHash: string | null;
        sequence: string;
        enabled: boolean;
      }[] = await manager.query(
        'SELECT "secretHash", "tokenHash", sequence, enabled FROM app_update_installations WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (current[0] && current[0].secretHash !== hash(secret))
        throw new ForbiddenException('Installation non reconnue.');
      if (current[0] && Number(current[0].sequence) >= input.sequence)
        return { registered: false, enabled: current[0].enabled };
      const tokenHash = token ? hash(token) : (current[0]?.tokenHash ?? null);
      // Token ownership is independent of any login and never changes a user's ride token.
      const values = [
        id,
        hash(secret),
        input.platform,
        version,
        build,
        input.enabled ? token : null,
        tokenHash,
        input.enabled,
        input.sequence,
      ];
      try {
        await manager.query(
          `INSERT INTO app_update_installations (id,"secretHash",platform,version,build,"pushToken","tokenHash",enabled,sequence)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET
          platform=EXCLUDED.platform, version=EXCLUDED.version, build=EXCLUDED.build, "pushToken"=EXCLUDED."pushToken",
          "tokenHash"=EXCLUDED."tokenHash", enabled=EXCLUDED.enabled, sequence=EXCLUDED.sequence, "updatedAt"=now()`,
          values,
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw new ConflictException(
            'Notifications déjà liées à une autre installation.',
          );
        throw error;
      }
      return { registered: true, enabled: input.enabled };
    });
  }
  async preview(releaseId: string) {
    this.available();
    const rows: { count: string }[] = await this.db.query(
      `SELECT count(*) FROM app_update_installations c
      JOIN app_store_releases r ON r.platform=c.platform WHERE r.id=$1 AND ${INSTALLATION_AUDIENCE_SQL}`,
      [releaseId],
    );
    return { eligibleInstallations: Number(rows[0]?.count ?? 0) };
  }
  async create(adminId: string, input: UpdateCampaignDto) {
    this.available();
    const title = input.title.trim(),
      body = input.body.trim();
    if (title.length < 3 || body.length < 3)
      throw new BadRequestException('Renseignez le titre et le message.');
    return this.db.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`update-campaign:${input.id}`],
      );
      const existing: {
        id: string;
        releaseId: string;
        title: string;
        body: string;
        createdBy: string;
      }[] = await manager.query(
        'SELECT * FROM app_update_campaigns WHERE id=$1',
        [input.id],
      );
      if (existing[0]) {
        if (
          existing[0].releaseId !== input.releaseId ||
          existing[0].title !== title ||
          existing[0].body !== body ||
          existing[0].createdBy !== adminId
        )
          throw new ConflictException(
            'Cet envoi a déjà été utilisé pour un autre message.',
          );
        return { id: input.id, queued: true };
      }
      const release: unknown[] = await manager.query(
        'SELECT id FROM app_store_releases WHERE id=$1 AND available=true FOR SHARE',
        [input.releaseId],
      );
      if (!release.length)
        throw new BadRequestException('Cette version n’est plus disponible.');
      await manager.query(
        `INSERT INTO app_update_campaigns (id,"releaseId",title,body,"createdBy") VALUES ($1,$2,$3,$4,$5)`,
        [input.id, input.releaseId, title, body, adminId],
      );
      return { id: input.id, queued: true };
    });
  }
  async list(): Promise<CampaignSummary[]> {
    this.available();
    // Counters describe provider acceptance, not proof a human read the push.
    return this.db.query<
      CampaignSummary[]
    >(`SELECT m.id,m."releaseId",m.title,m.body,m.active,m."createdAt",
      (SELECT count(*) FROM notifications n WHERE n."eventKey" >= 'installation-message:' || m.id || ':00000000-0000-0000-0000-000000000000' AND n."eventKey" <= 'installation-message:' || m.id || ':ffffffff-ffff-ffff-ffff-ffffffffffff') AS queued,
      (SELECT count(*) FROM notifications n WHERE n."eventKey" >= 'installation-message:' || m.id || ':00000000-0000-0000-0000-000000000000' AND n."eventKey" <= 'installation-message:' || m.id || ':ffffffff-ffff-ffff-ffff-ffffffffffff' AND n.status='sent') AS sent
      FROM app_update_campaigns m ORDER BY m."createdAt" DESC LIMIT 30`);
  }
  async withdraw(id: string) {
    this.available();
    await this.db.query(
      'UPDATE app_update_campaigns SET active=false WHERE id=$1',
      [id],
    );
    return { withdrawn: true };
  }
}
