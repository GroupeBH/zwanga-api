import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { normalizeUploadedImage } from '../../common/image-upload-policy';
import { KycEvidenceRepository } from './kyc-evidence.repository';
import { KycEvidenceTransport } from './kyc-evidence.transport';
import { KycEvidenceStorage } from './kyc-evidence.storage';
import { DiditFullCollector } from './didit-full-collector';
import { ATTACHMENTS, AttachmentKind } from './didit-archive.policy';
import {
  archiveConfig,
  ARCHIVE_MAX_BYTES,
  MEDIA_MAX_BYTES,
  EvidenceBundle,
  ArchiveRow,
  extractEvidence,
} from './kyc-evidence.policy';

@Injectable()
export class KycEvidenceService {
  private readonly logger = new Logger(KycEvidenceService.name);
  private working = false;
  private activeReads = 0;
  private activeAttachment = false;
  constructor(
    private readonly config: ConfigService,
    private readonly repository: KycEvidenceRepository,
    private readonly transport: KycEvidenceTransport,
    private readonly storage: KycEvidenceStorage,
    @Optional() private readonly fullCollector?: DiditFullCollector,
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
    if ((row.revision ?? 0) > 0) {
      if (!this.fullCollector) throw new Error('FULL_COLLECTOR_NOT_CONFIGURED');
      return this.fullCollector.capture(row, config);
    }
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
          if (image.buffer.length > MEDIA_MAX_BYTES)
            throw new Error('MEDIA_TOO_LARGE');
          const data = image.buffer.toString('base64');
          if (bytes + data.length > ARCHIVE_MAX_BYTES - 128 * 1024)
            throw new Error('ARCHIVE_TOO_LARGE');
          bytes += data.length;
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
      await this.storage.writeImages(key, bundle);
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

  private async load<T extends { sessionId: string }>(
    kycId: string,
    id: string,
    adminId: string,
    action: 'read' | 'file',
    read: (key: string) => Promise<T>,
  ): Promise<T> {
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
      const bundle = await read(row.objectKey);
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
    const bundle = await this.load(kycId, id, adminId, 'read', (key) =>
      this.storage.readMetadata(key),
    );
    return {
      details: bundle.details,
      capturedAt: bundle.capturedAt,
      missing: bundle.missing,
      ...(bundle.attachments ? { attachments: bundle.attachments } : {}),
      files: bundle.files.map((file, index) => ({
        kind: file.kind,
        nodeId: file.nodeId,
        mimeType: file.mimeType,
        size: file.size,
        sha256: file.sha256,
        index,
      })),
    };
  }
  async file(kycId: string, id: string, index: number, adminId: string) {
    if (!Number.isInteger(index) || index < 0 || index >= 12)
      throw new NotFoundException('Justificatif introuvable');
    const file = await this.load(kycId, id, adminId, 'file', (key) =>
      this.storage.readFile(key, index),
    );
    if (!file.data) throw new NotFoundException('Justificatif introuvable');
    return file.data;
  }

  async attachment(kycId: string, id: string, kind: string, adminId: string) {
    if (!Object.hasOwn(ATTACHMENTS, kind))
      throw new NotFoundException('Pièce introuvable');
    if (this.activeAttachment)
      throw new ServiceUnavailableException('Téléchargement KYC occupé');
    this.activeAttachment = true;
    let result:
      Awaited<ReturnType<KycEvidenceStorage['readAttachment']>> | undefined;
    try {
      result = await this.load(kycId, id, adminId, 'file', async (key) => {
        result = await this.storage.readAttachment(key, kind as AttachmentKind);
        return result;
      });
      if (!result.attachment) throw new NotFoundException('Pièce indisponible');
      if (result.attachment.body.destroyed)
        throw new ServiceUnavailableException('Téléchargement expiré');
      result.attachment.body.once('close', () => {
        this.activeAttachment = false;
      });
      result.attachment.body.once('end', () => {
        this.activeAttachment = false;
      });
      return result.attachment;
    } catch (error) {
      result?.attachment?.body.destroy();
      this.activeAttachment = false;
      throw error;
    }
  }
}
