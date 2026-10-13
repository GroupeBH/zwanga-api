import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { normalizeUploadedImage } from '../../common/image-upload-policy';
import {
  EvidenceBundle,
  EvidenceFile,
} from '../kyc-evidence/kyc-evidence.policy';
import { KycEvidenceStorage } from '../kyc-evidence/kyc-evidence.storage';
import { AwsKycRepository } from './aws-kyc.repository';
import { AwsKycTransport } from './aws-kyc.transport';
import { AwsKycSession } from './aws-kyc-session.entity';
import { awsKycFailureCode } from './aws-kyc.diagnostics';
import {
  AWS_DOCUMENT_TYPES,
  AWS_KYC_CONSENT,
  awsKycConfig,
  awsKycAvailability,
  AwsDocumentType,
  inspectDocument,
  publicAwsSession,
} from './aws-kyc.policy';

@Injectable()
export class AwsKycService {
  private readonly logger = new Logger(AwsKycService.name);
  private working = false;
  constructor(
    private readonly config: ConfigService,
    private readonly repository: AwsKycRepository,
    private readonly transport: AwsKycTransport,
    private readonly storage: KycEvidenceStorage,
  ) {}

  capabilities() {
    return {
      ...awsKycAvailability(this.config),
      provider: 'aws',
      country: 'COD',
      documentTypes: [...AWS_DOCUMENT_TYPES],
      consentVersion: AWS_KYC_CONSENT,
      manualReviewRequired: false,
      reviewPolicy: 'automatic_with_manual_fallback',
      maxImageBytes: 5 * 1024 * 1024,
    };
  }
  private settings() {
    const c = awsKycConfig(this.config);
    if (!c)
      throw new ServiceUnavailableException(
        { code: 'AWS_KYC_DISABLED', message: 'Le parcours KYC AWS n’est pas encore disponible.' },
      );
    return c;
  }
  private async file(
    buffer: Buffer,
    kind: EvidenceFile['kind'],
  ): Promise<EvidenceFile> {
    const image = await normalizeUploadedImage(buffer);
    if (image.size > 5 * 1024 * 1024)
      throw new BadRequestException('Image trop volumineuse.');
    return {
      kind,
      nodeId: null,
      data: image.buffer.toString('base64'),
      size: image.size,
      mimeType: 'image/jpeg',
      sha256: createHash('sha256').update(image.buffer).digest('hex'),
    };
  }
  async create(
    userId: string,
    dto: {
      requestId: string;
      documentType: AwsDocumentType;
      consentVersion: string;
    },
    files: { front?: Express.Multer.File[]; back?: Express.Multer.File[] },
  ) {
    const config = this.settings();
    if (
      !files?.front?.[0] ||
      (dto.documentType !== 'passport' && !files.back?.[0])
    )
      throw new BadRequestException(
        'Photographiez le recto et le verso de votre pièce (page d’identité pour un passeport).',
      );
    const images = [await this.file(files.front[0].buffer, 'document_front')];
    if (files.back?.[0])
      images.push(await this.file(files.back[0].buffer, 'document_back'));
    const { row, user, fresh } = await this.repository.reserve(
      userId,
      dto.requestId,
      dto.documentType,
      dto.consentVersion,
      config,
    );
    if (!fresh) return this.status(userId, row.id);
    try {
      await this.storage.write(row.objectKey!, {
        version: 1,
        sessionId: row.id,
        capturedAt: new Date().toISOString(),
        details: {
          provider: 'aws',
          country: 'COD',
          documentType: row.documentType,
          consentVersion: dto.consentVersion,
          firstName: user.firstName,
          lastName: user.lastName,
        },
        files: images,
        missing: ['selfie'],
      });
      await this.repository.transition(row, 'documents');
    } catch (error) {
      this.logger.warn(`AWS KYC upload failed (${awsKycFailureCode(error)})`);
      await this.repository.transition(
        row,
        'failed',
        {},
        row.objectKey,
        'UPLOAD_FAILED',
      );
      throw new ServiceUnavailableException(
        'Envoi interrompu. Réessayez la vérification.',
      );
    }
    return this.status(userId, row.id);
  }
  async status(userId: string, id?: string) {
    const row = await this.repository.owned(userId, id);
    return publicAwsSession(row, row.kyc.status);
  }
  async startLiveness(userId: string, id: string) {
    const config = this.settings();
    const owned = await this.repository.owned(userId, id);
    if (owned.kyc.status !== 'pending')
      throw new ConflictException(
        'Ce dossier a déjà reçu une décision. Actualisez votre statut.',
      );
    const { row, fresh } = await this.repository.start(userId, id);
    try {
      if (fresh) {
        row.livenessId = await this.transport.create(row.region, row.id);
        const changed = await this.repository.setLiveness(row, row.livenessId);
        if (!changed.affected) throw new Error('SESSION_UNAVAILABLE');
      }
      await this.repository.owned(userId, id);
      const credentials = await this.transport.credentials(
        row.region,
        config.roleArn,
        row.id,
      );
      return {
        id: row.id,
        sessionId: row.livenessId,
        region: row.region,
        expiresAt: row.expiresAt,
        credentials,
      };
    } catch (error) {
      this.logger.warn(`AWS KYC capture unavailable (${awsKycFailureCode(error)})`);
      // Same ClientRequestToken on recovery. Never silently create a second charged session.
      if (fresh) await this.repository.retry(row);
      throw new ServiceUnavailableException(
        'Capture momentanément indisponible. Réessayez dans un instant.',
      );
    }
  }

  @Cron('*/5 * * * * *')
  async tick() {
    if (this.working || String(this.config.get('AWS_KYC_ENABLED')) !== 'true')
      return;
    this.working = true;
    try {
      this.settings();
      const expired = await this.repository.claimExpired();
      if (expired)
        await this.repository.transition(
          expired,
          'failed',
          expired.checks,
          expired.objectKey,
          'SESSION_EXPIRED',
        );
      // Bounded per replica. DB leases coordinate overlapping ECS tasks.
      for (let i = 0; i < 2; i++) {
        const row = await this.repository.claim();
        if (!row) break;
        await this.process(row);
      }
    } catch (error) {
      this.logger.warn(`AWS KYC worker unavailable (${awsKycFailureCode(error)}); no identity approved`);
    } finally {
      this.working = false;
    }
  }

  async process(row: AwsKycSession) {
    try {
      const config = this.settings();
      await this.repository.owned(row.userId, row.id);
      if (row.runs > 3) {
        await this.repository.transition(
          row,
          'failed',
          row.checks,
          row.objectKey,
          'SERVICE_UNAVAILABLE',
        );
        return;
      }
      if (row.expiresAt.getTime() <= Date.now()) {
        await this.repository.transition(
          row,
          'failed',
          row.checks,
          row.objectKey,
          'SESSION_EXPIRED',
        );
        return;
      }
      const bundle = await this.storage.read(row.objectKey!);
      if (bundle.sessionId !== row.id)
        throw new Error('SESSION_OWNER_MISMATCH');
      const front = bundle.files.find((f) => f.kind === 'document_front');
      if (!front) throw new Error('MISSING_DOCUMENT');
      if (row.state === 'documents') {
        const lines = (
          await Promise.all(
            bundle.files
              .filter((f) => f.kind !== 'selfie')
              .map((f) =>
                this.transport.ocr(row.region, Buffer.from(f.data, 'base64')),
              ),
          )
        ).flat();
        const result = inspectDocument(
          lines,
          row.documentType,
          String(bundle.details.firstName),
          String(bundle.details.lastName),
        );
        // Empty/unreadable photographs must be recaptured before spending on Liveness.
        if (lines.filter((l) => l.confidence >= 90).length < 3) {
          await this.repository.transition(
            row,
            'failed',
            {},
            row.objectKey,
            'DOCUMENT_UNREADABLE',
          );
          return;
        }
        bundle.details.ocr = lines;
        bundle.details.documentCheck = result;
        const key = await this.snapshot(row, bundle);
        await this.repository.transition(
          row,
          'ready',
          {
            document: result.document,
            names: result.names,
            validity: result.validity,
            ocr: result.ocr,
          },
          key,
        );
      } else if (row.state === 'liveness') {
        const result = await this.transport.result(row.region, row.livenessId!);
        if (result.SessionId !== row.livenessId)
          throw new Error('SESSION_OWNER_MISMATCH');
        if (['CREATED', 'IN_PROGRESS'].includes(result.Status ?? '')) {
          await this.repository.transition(row, 'liveness');
          return;
        }
        if (
          result.Status !== 'SUCCEEDED' ||
          !Number.isFinite(result.Confidence) ||
          result.Confidence! < config.liveness ||
          result.Challenge?.Type !== 'FaceMovementAndLightChallenge' ||
          !result.ReferenceImage?.Bytes?.length
        ) {
          await this.repository.transition(
            row,
            'failed',
            { ...row.checks, liveness: 'failed' },
            row.objectKey,
            'LIVENESS_FAILED',
          );
          return;
        }
        // This frame comes ONLY from AWS, never from the phone's completion callback.
        bundle.files.push(
          await this.file(Buffer.from(result.ReferenceImage.Bytes), 'selfie'),
        );
        bundle.missing = [];
        bundle.details.liveness = {
          confidence: result.Confidence,
          challenge: result.Challenge,
          threshold: config.liveness,
        };
        const key = await this.snapshot(row, bundle);
        await this.repository.transition(
          row,
          'compare',
          { ...row.checks, liveness: 'passed' },
          key,
        );
      } else if (row.state === 'compare') {
        const selfie = bundle.files.find((f) => f.kind === 'selfie');
        if (!selfie || row.checks.liveness !== 'passed')
          throw new Error('MISSING_LIVENESS');
        const face = await this.transport.compare(
          row.region,
          Buffer.from(front.data, 'base64'),
          Buffer.from(selfie.data, 'base64'),
          config.similarity,
        );
        bundle.details.face = { ...face, threshold: config.similarity };
        const key = await this.snapshot(row, bundle);
        await this.repository.transition(
          row,
          'review',
          { ...row.checks, face: face.passed ? 'passed' : 'review' },
          key,
          face.passed ? null : face.reason,
        );
      }
    } catch (error) {
      // No provider payload, image, URL, names, STS credential or biometric score in logs.
      await this.repository.retry(row);
      this.logger.warn(`AWS KYC processing deferred (${awsKycFailureCode(error)})`);
    }
  }
  private async snapshot(row: AwsKycSession, bundle: EvidenceBundle) {
    const key = await this.repository.snapshotKey(row);
    await this.storage.write(key, bundle);
    return key;
  }
}
