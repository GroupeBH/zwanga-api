import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { normalizeUploadedImage } from '../../common/image-upload-policy';
import {
  archiveConfig,
  ArchiveRow,
  EvidenceBundle,
  extractEvidence,
  MEDIA_MAX_BYTES,
  ARCHIVE_MAX_BYTES,
} from './kyc-evidence.policy';
import {
  archiveProviderData,
  diditObject,
  ownedDecision,
  printableStatus,
} from './didit-archive.policy';
import { DiditArchiveTransport } from './didit-archive.transport';
import { KycEvidenceTransport } from './kyc-evidence.transport';
import { KycEvidenceStorage } from './kyc-evidence.storage';
import { KycEvidenceRepository } from './kyc-evidence.repository';

@Injectable()
export class DiditFullCollector {
  constructor(
    private readonly api: DiditArchiveTransport,
    private readonly media: KycEvidenceTransport,
    private readonly storage: KycEvidenceStorage,
    private readonly repository: KycEvidenceRepository,
  ) {}

  async capture(
    row: ArchiveRow,
    config: NonNullable<ReturnType<typeof archiveConfig>>,
  ) {
    const started = Date.now();
    const check = () => {
      if (
        !row.userId ||
        Date.now() - started > 360_000 ||
        (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now())
      )
        throw new Error('CAPTURE_EXPIRED');
    };
    try {
      check();
      const decision = await this.api.decision(row.sessionId, config.apiKey);
      const owned = ownedDecision(decision, row.sessionId, row.userId!);
      const key = row.objectKeys[row.objectKeys.length - 1];
      const bundle: EvidenceBundle = {
        version: 1,
        sessionId: row.sessionId,
        capturedAt: new Date().toISOString(),
        details: {
          collection: 'full',
          revision: row.revision,
          status: owned.status,
        },
        files: [],
        attachments: [],
        missing: [],
      };
      const coverage: Record<string, string> = { decision: 'captured' };
      const data: Record<string, unknown> = {
        schemaVersion: 1,
        sessionId: row.sessionId,
        userId: row.userId,
        capturedAt: bundle.capturedAt,
        decision,
        coverage,
        redactions: [
          'credential fields',
          'URL credentials, query strings and fragments',
        ],
      };
      const part = async (name: string, work: () => Promise<void>) => {
        check();
        try {
          await work();
          coverage[name] = 'captured';
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === 'SESSION_OWNER_MISMATCH'
          )
            throw error;
          coverage[name] = 'unavailable';
          bundle.missing.push(name);
        }
      };
      // Keep BOTH response shapes: include=events changes some standard fields.
      await part('expanded_decision', async () => {
        const value = await this.api.decision(
          row.sessionId,
          config.apiKey,
          true,
        );
        ownedDecision(value, row.sessionId, row.userId!);
        data.expandedDecision = value;
      });
      await part('user_profile', async () => {
        const value = await this.api.user(row.userId!, config.apiKey);
        if (diditObject(value).vendor_data !== row.userId)
          throw new Error('SESSION_OWNER_MISMATCH');
        data.user = value;
      });
      if (printableStatus(owned.status)) {
        await part('report', async () => {
          const pdf = await this.api.report(row.sessionId, config.apiKey);
          check();
          bundle.attachments!.push(
            await this.storage.writeAttachment(key, 'report', pdf, pdf.length),
          );
        });
      } else coverage.report = 'not_applicable_yet';
      await part('original_files', async () => {
        let exportId =
          row.exportRevision === row.revision ? row.exportId : null;
        let value: Record<string, unknown>;
        const verify = (payload: unknown) => {
          const record = diditObject(payload);
          if (
            record.session_id !== row.sessionId ||
            typeof record.export_id !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              record.export_id,
            ) ||
            (exportId && record.export_id !== exportId)
          )
            throw new Error('SESSION_OWNER_MISMATCH');
          return record;
        };
        if (!exportId) {
          value = verify(
            await this.api.startExport(
              row.sessionId,
              config.apiKey,
              `zwanga:${row.id}:${row.revision}`,
            ),
          );
          exportId = value.export_id as string;
          if (!(await this.repository.saveExport(row, exportId)))
            throw new Error('CAPTURE_SUPERSEDED');
        }
        // GET, not replayed POST: an idempotent POST can retain its original PENDING response.
        value = verify(
          await this.api.exportStatus(row.sessionId, exportId, config.apiKey),
        );
        data.filesExport = value;
        if (value.status !== 'READY' || typeof value.download_url !== 'string')
          throw new Error('EXPORT_NOT_READY');
        const size = value.size_bytes;
        if (typeof size !== 'number') throw new Error('INVALID_EXPORT_SIZE');
        check();
        const stream = await this.api.originals(
          value.download_url,
          config.hosts,
          size,
        );
        try {
          bundle.attachments!.push(
            await this.storage.writeAttachment(
              key,
              'original_files',
              stream,
              size,
            ),
          );
        } finally {
          stream.destroy();
        }
      });

      // Compatibility previews only. All originals, including additional steps,
      // documents and videos, are in the ZIP, never truncated to this whitelist.
      await part('previews', async () => {
        const extracted = extractEvidence(decision, row.sessionId, row.userId!);
        let bytes = 0;
        for (const item of extracted.media) {
          check();
          const image = await normalizeUploadedImage(
            await this.media.image(item.url, config.hosts),
          );
          const encoded = image.buffer.toString('base64');
          bytes += encoded.length;
          if (
            image.buffer.length > MEDIA_MAX_BYTES ||
            bytes > ARCHIVE_MAX_BYTES - 128 * 1024
          )
            throw new Error('PREVIEW_TOO_LARGE');
          bundle.files.push({
            kind: item.kind,
            nodeId: item.nodeId,
            mimeType: 'image/jpeg',
            size: image.buffer.length,
            data: encoded,
            sha256: createHash('sha256').update(image.buffer).digest('hex'),
          });
        }
      });
      check();
      data.coverage = coverage;
      const json = Buffer.from(JSON.stringify(archiveProviderData(data)));
      bundle.attachments!.push(
        await this.storage.writeAttachment(
          key,
          'provider_data',
          json,
          json.length,
        ),
      );
      bundle.details.coverage = coverage;
      check();
      await this.storage.writeImages(key, bundle);
      await this.repository.finish(
        row,
        bundle.missing.length
          ? row.attempts < 12
            ? 'pending'
            : 'partial'
          : 'ready',
        key,
        bundle.missing.length ? 'FULL_EVIDENCE_INCOMPLETE' : null,
      );
    } catch (error) {
      const code =
        error instanceof Error &&
        ['SESSION_OWNER_MISMATCH', 'CAPTURE_EXPIRED'].includes(error.message)
          ? error.message
          : 'FULL_CAPTURE_FAILED';
      await this.repository.finish(
        row,
        row.attempts >= 12 || code === 'SESSION_OWNER_MISMATCH'
          ? 'failed'
          : 'pending',
        null,
        code,
      );
    }
  }
}
