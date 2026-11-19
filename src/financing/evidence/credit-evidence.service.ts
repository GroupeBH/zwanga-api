import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CreditStore } from '../shared/credit.store';
import { S3Service } from '../../common/services/s3.service';
import type { CreditActor } from '../shared/credit.store';
import { normalizeUploadedImage } from '../../common/image-upload-policy';
import type { IdRow } from '../shared/credit.rows';
import { createHash } from 'node:crypto';

@Injectable()
export class CreditEvidenceService {
  constructor(
    private readonly store: CreditStore,
    private readonly s3: S3Service,
  ) {}

  async upload(actor: CreditActor, file: Express.Multer.File) {
    if (!file?.buffer || file.buffer.length > 5 * 1024 * 1024)
      throw new BadRequestException('Image de 5 Mo maximum requise.');
    const image = await normalizeUploadedImage(file.buffer);
    // Dedicated private prefix; never use the public/local upload fallback for credit evidence.
    const storageKey = await this.s3.uploadFile(
      image.buffer,
      'pro',
      image.mimetype,
      image.originalname,
    );
    const [result] = await this.store.db.query<IdRow[]>(
      'INSERT INTO pro_credit_attachments("ownerId","storageKey",sha256,"mimeType") VALUES($1,$2,$3,$4) RETURNING id',
      [
        actor.userId,
        storageKey,
        createHash('sha256').update(image.buffer).digest('hex'),
        image.mimetype,
      ],
    );
    return result;
  }

  async attachment(actor: CreditActor, id: string) {
    const [a] = await this.store.db.query<
      { ownerId: string; storageKey: string }[]
    >('SELECT * FROM pro_credit_attachments WHERE id=$1', [id]);
    if (!a) throw new NotFoundException('Pièce introuvable.');
    if (a.ownerId !== actor.userId) {
      const [ownContract] = await this.store.db.query<{ creditId: string }[]>(
        `SELECT p."creditId" FROM pro_credit_contracts p JOIN asset_credits c ON c.id=p."creditId"
        WHERE p."deliveryProofId"=$1 AND c."driverId"=$2`,
        [id, actor.userId],
      );
      if (!ownContract)
        await this.store.authorize(this.store.db.manager, actor, [
          'analyst',
          'documents',
          'auditor',
        ]);
    }
    await this.store.audit(
      this.store.db.manager,
      actor.userId,
      'attachment_accessed',
      { attachmentId: id },
    );
    const url: unknown = await this.s3.getPresignedUrl(a.storageKey, 120);
    if (typeof url !== 'string' || !url.startsWith('https://'))
      throw new ServiceUnavailableException(
        'Pièce temporairement indisponible.',
      );
    return { url, expiresIn: 120 };
  }
}
