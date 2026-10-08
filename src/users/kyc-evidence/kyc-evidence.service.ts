import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { normalizeUploadedImage } from '../../common/image-upload-policy';
import { KycEvidenceRepository } from './kyc-evidence.repository';
import { KycEvidenceTransport } from './kyc-evidence.transport';
import { KycEvidenceStorage } from './kyc-evidence.storage';
import {
  archiveConfig,
  ARCHIVE_MAX_BYTES,
  EvidenceBundle,
  ArchiveRow,
  extractEvidence,
} from './kyc-evidence.policy';

@Injectable()
export class KycEvidenceService {
  private readonly logger = new Logger(KycEvidenceService.name);
  private working = false;
  private activeReads = 0;
  constructor(
    private readonly config: ConfigService,
    private readonly repository: KycEvidenceRepository,
    private readonly transport: KycEvidenceTransport,
    private readonly storage: KycEvidenceStorage,
  ) {}

  @Cron('*/1 * * * *')
  async tick() {
    if (this.working) return;
    this.working = true;
    try {
      // Purging must continue even when new collection has been disabled.
      for (let i = 0; i < 2; i++) {
        const row = await this.repository.claimPurge();
        if (!row) break;
        try {
          const purgeStarted = Date.now();
          for (const key of row.objectKeys) {
            if (Date.now() - purgeStarted > 240_000)
              throw new Error('PURGE_TIMEOUT');
            await this.storage.remove(key);
          }
          await this.repository.finishPurge(row, true);
        } catch {
          await this.repository.finishPurge(row, false);
          this.logger.warn('KYC evidence purge requires retry');
        }
      }
      const config = archiveConfig(this.config);
      if (config) {
        const row = await this.repository.claim();
        if (row) await this.capture(row, config);
      }
    } catch {
      this.logger.warn('KYC evidence worker unavailable; retained for retry');
    } finally {
      this.working = false;
    }
  }

  async capture(
    row: ArchiveRow,
    config: NonNullable<ReturnType<typeof archiveConfig>>,
  ) {
    const started = Date.now();
    try {
      const payload = await this.transport.decision(
        row.sessionId,
        config.apiKey,
      );
      const extracted = extractEvidence(payload, row.sessionId, row.userId!);
      const bundle: EvidenceBundle = {
        version: 1,
        sessionId: row.sessionId,
        capturedAt: new Date().toISOString(),
        details: extracted.details,
        files: [],
        missing: [],
      };
      let bytes = 0;
      for (const media of extracted.media) {
        if (Date.now() - started > 240_000) throw new Error('CAPTURE_TIMEOUT');
        try {
          // Re-encode copies to remove EXIF/GPS and reject invalid/decompression-bomb files.
          const image = await normalizeUploadedImage(
            await this.transport.image(media.url, config.hosts),
          );
          const data = image.buffer.toString('base64');
          bytes += data.length;
          if (bytes > ARCHIVE_MAX_BYTES - 128 * 1024)
            throw new Error('ARCHIVE_TOO_LARGE');
          bundle.files.push({
            kind: media.kind,
            nodeId: media.nodeId,
            mimeType: 'image/jpeg',
            data,
            size: image.buffer.length,
            sha256: createHash('sha256').update(image.buffer).digest('hex'),
          });
        } catch {
          bundle.missing.push(`${media.kind}:${media.nodeId ?? 'unknown'}`);
        }
      }
      if (!bundle.files.some((f) => f.kind === 'document_front'))
        bundle.missing.push('document_front');
      if (!bundle.files.some((f) => f.kind === 'selfie'))
        bundle.missing.push('selfie');
      if (bundle.missing.length && row.attempts < 5) {
        await this.repository.finish(
          row,
          'pending',
          null,
          'EVIDENCE_INCOMPLETE',
        );
        return;
      }
      if (
        Date.now() - started > 240_000 ||
        (row.expiresAt !== null &&
          new Date(row.expiresAt).getTime() <= Date.now())
      )
        throw new Error('CAPTURE_EXPIRED');
      const key = row.objectKeys[row.objectKeys.length - 1];
      await this.storage.write(key, bundle);
      await this.repository.finish(
        row,
        bundle.missing.length ? 'partial' : 'ready',
        key,
        bundle.missing.length ? 'EVIDENCE_INCOMPLETE' : null,
      );
    } catch (error) {
      // Deliberately never log provider bodies, URLs, API keys or identity fields.
      const code =
        error instanceof Error &&
        [
          'SESSION_OWNER_MISMATCH',
          'SESSION_UNAVAILABLE',
          'UNSUPPORTED_DECISION_SHAPE',
          'TOO_MANY_VERIFICATION_STEPS',
        ].includes(error.message)
          ? error.message
          : 'CAPTURE_FAILED';
      await this.repository.finish(
        row,
        row.attempts >= 5 || code === 'SESSION_OWNER_MISMATCH'
          ? 'failed'
          : 'pending',
        null,
        code,
      );
      this.logger.warn(`KYC evidence capture deferred (${code})`);
    }
  }

  async request(kycId: string, adminId: string) {
    if (!archiveConfig(this.config))
      throw new ServiceUnavailableException(
        'Archivage KYC non configuré : durée, hôtes et stockage privé requis.',
      );
    if (!(await this.repository.request(kycId)))
      throw new NotFoundException('Dossier KYC introuvable');
    const rows = await this.repository.list(kycId);
    for (const row of rows)
      await this.repository.audit(row.id, adminId, 'enqueue');
    return { archives: rows };
  }
  list(kycId: string) {
    return this.repository.list(kycId);
  }
  async expire(kycId: string, id: string, adminId: string) {
    if (!(await this.repository.expire(kycId, id, adminId)))
      throw new NotFoundException('Archive introuvable');
    return { accessRevoked: true, purgePending: true };
  }

  private async load(
    kycId: string,
    id: string,
    adminId: string,
    action: 'read' | 'file',
  ) {
    const row = await this.repository.readable(kycId, id);
    if (!row?.objectKey)
      throw new NotFoundException('Archive indisponible ou expirée');
    if (this.activeReads >= 2)
      throw new ServiceUnavailableException(
        'Lecture KYC occupée. Réessayez dans un instant.',
      );
    this.activeReads++;
    try {
      await this.repository.audit(id, adminId, action);
      const bundle = await this.storage.read(row.objectKey);
      if (
        bundle.sessionId !== row.sessionId ||
        !(await this.repository.readable(kycId, id))
      )
        throw new Error('ARCHIVE_UNAVAILABLE');
      return bundle;
    } catch {
      throw new ServiceUnavailableException(
        'Archive temporairement indisponible',
      );
    } finally {
      this.activeReads--;
    }
  }
  async details(kycId: string, id: string, adminId: string) {
    const bundle = await this.load(kycId, id, adminId, 'read');
    return {
      details: bundle.details,
      capturedAt: bundle.capturedAt,
      missing: bundle.missing,
      files: bundle.files.map(({ data: _data, ...file }, index) => ({
        ...file,
        index,
      })),
    };
  }
  async file(kycId: string, id: string, index: number, adminId: string) {
    if (!Number.isInteger(index) || index < 0 || index >= 12)
      throw new NotFoundException('Justificatif introuvable');
    const bundle = await this.load(kycId, id, adminId, 'file'),
      file = bundle.files[index];
    if (!file) throw new NotFoundException('Justificatif introuvable');
    return Buffer.from(file.data, 'base64');
  }
}
