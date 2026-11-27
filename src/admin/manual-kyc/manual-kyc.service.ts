import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { normalizeUploadedImage } from '../../common/image-upload-policy';
import {
  EvidenceBundle,
  EvidenceFile,
  MEDIA_MAX_BYTES,
} from '../../users/kyc-evidence/kyc-evidence.policy';
import { KycEvidenceStorage } from '../../users/kyc-evidence/kyc-evidence.storage';
import { KycEvidenceService } from '../../users/kyc-evidence/kyc-evidence.service';
import { ManualKycRepository } from './manual-kyc.repository';
import { parseManualKycInput } from './manual-kyc.schema';

export const MANUAL_UPLOADS = [
  'document_front',
  'document_back',
  'selfie',
  'address_proof',
] as const;
export type ManualUploads = Partial<
  Record<(typeof MANUAL_UPLOADS)[number], Express.Multer.File[]>
>;
@Injectable()
export class ManualKycService {
  private saving = false;
  constructor(
    private readonly repo: ManualKycRepository,
    private readonly storage: KycEvidenceStorage,
    private readonly evidence: KycEvidenceService,
    private readonly config: ConfigService,
  ) {}
  async read(userId: string, adminId: string) {
    const { kycId, archive } = await this.repo.current(userId);
    const empty = {
      kycId,
      archiveId: archive?.id ?? null,
      revision: archive?.revision ?? 0,
      fields: {},
      note: '',
      files: [],
      recordedBy: null,
      recordedAt: null,
    };
    if (!archive?.objectKey) return empty;
    const details = await this.evidence.details(kycId!, archive.id, adminId);
    if (details.details.source !== 'administrator')
      throw new ServiceUnavailableException('Source de dossier invalide');
    return {
      ...empty,
      fields: details.details.fields,
      note: details.details.note,
      files: details.files,
      recordedBy: details.details.recordedBy,
      recordedAt: details.capturedAt,
    };
  }
  async save(
    userId: string,
    adminId: string,
    raw: unknown,
    uploads: ManualUploads = {},
  ) {
    const input = parseManualKycInput(raw);
    if (
      !this.config.get('AWS_S3_BUCKET_NAME') ||
      this.config.get('AWS_S3_PUBLIC_BUCKET') === 'true'
    )
      throw new ServiceUnavailableException(
        'Un stockage privé KYC doit être configuré.',
      );
    const days = Number(this.config.get('KYC_MANUAL_RETENTION_DAYS') ?? 1095);
    if (!Number.isInteger(days) || days < 1 || days > 3650)
      throw new ServiceUnavailableException(
        'Durée de conservation KYC invalide',
      );
    if (this.saving)
      throw new ServiceUnavailableException(
        'Une saisie KYC est en cours. Réessayez dans un instant.',
      );
    this.saving = true;
    try {
      if (
        Object.keys(uploads).some(
          (name) => !MANUAL_UPLOADS.includes(name as any),
        )
      )
        throw new BadRequestException('Pièce non reconnue');
      const files: EvidenceFile[] = [];
      for (const slot of MANUAL_UPLOADS) {
        const entries = uploads[slot] ?? [];
        if (entries.length > 1)
          throw new BadRequestException('Une seule image par pièce');
        if (!entries.length) continue;
        if (entries[0].buffer.length > MEDIA_MAX_BYTES)
          throw new BadRequestException(
            'Image trop volumineuse (5 Mio maximum)',
          );
        const image = await normalizeUploadedImage(entries[0].buffer);
        if (image.buffer.length > MEDIA_MAX_BYTES)
          throw new BadRequestException('Image trop volumineuse');
        files.push({
          kind: slot === 'address_proof' ? 'document_front' : slot,
          nodeId: slot,
          mimeType: 'image/jpeg',
          size: image.buffer.length,
          data: image.buffer.toString('base64'),
          sha256: createHash('sha256').update(image.buffer).digest('hex'),
        });
      }
      if (!Object.keys(input.fields).length && !files.length)
        throw new BadRequestException(
          'Renseignez au moins une information ou ajoutez une image.',
        );
      const row = await this.repo.reserve(userId, input, days);
      try {
        let previous: EvidenceFile[] = [];
        if (row.objectKey) {
          const prior = await this.storage.read(row.objectKey);
          if (
            prior.sessionId !== row.sessionId ||
            prior.details.source !== 'administrator'
          )
            throw new Error('MANUAL_OWNER_MISMATCH');
          previous = prior.files.filter(
            (file) => !files.some((added) => added.nodeId === file.nodeId),
          );
        }
        const bundle: EvidenceBundle = {
          version: 1,
          sessionId: row.sessionId,
          capturedAt: new Date().toISOString(),
          details: {
            source: 'administrator',
            fields: input.fields,
            note: input.note,
            recordedBy: adminId,
            revision: (row.revision ?? 0) + 1,
            providerResultsUnchanged: true,
          },
          files: [...previous, ...files],
          missing: [],
        };
        await this.storage.writeImages(
          row.objectKeys[row.objectKeys.length - 1],
          bundle,
        );
        await this.repo.finish(row, adminId);
        return {
          kycId: row.kycId,
          archiveId: row.id,
          revision: (row.revision ?? 0) + 1,
          validationUnchanged: true,
        };
      } catch (error) {
        await this.repo.release(row);
        if (error instanceof HttpException) throw error;
        throw new ServiceUnavailableException(
          'Enregistrement privé indisponible. Rechargez le dossier avant de réessayer.',
        );
      }
    } finally {
      this.saving = false;
    }
  }
}
