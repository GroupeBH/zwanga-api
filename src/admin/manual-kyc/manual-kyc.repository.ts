import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  ArchiveRow,
  archiveObjectKey,
} from '../../users/kyc-evidence/kyc-evidence.policy';
import { ManualKycInput } from './manual-kyc.schema';

@Injectable()
export class ManualKycRepository {
  constructor(private readonly db: DataSource) {}
  async current(userId: string) {
    const [user] = await this.db.query('SELECT id FROM users WHERE id=$1', [
      userId,
    ]);
    if (!user) throw new NotFoundException('Utilisateur introuvable');
    const [kyc] = await this.db.query(
      'SELECT id FROM kyc_documents WHERE "userId"=$1 ORDER BY "createdAt" DESC,id DESC LIMIT 1',
      [userId],
    );
    if (!kyc) return { kycId: null, archive: null };
    const [archive] = await this.db.query(
      `SELECT * FROM kyc_evidence_archives WHERE "kycId"=$1 AND "captureKind"='manual'`,
      [kyc.id],
    );
    return {
      kycId: kyc.id as string,
      archive: (archive ?? null) as ArchiveRow | null,
    };
  }
  async reserve(
    userId: string,
    input: ManualKycInput,
    days: number,
  ): Promise<ArchiveRow> {
    return this.db.transaction(async (m) => {
      const [user] = await m.query(
        'SELECT id,"isActive",status FROM users WHERE id=$1 FOR UPDATE',
        [userId],
      );
      if (!user) throw new NotFoundException('Utilisateur introuvable');
      if (!user.isActive || ['inactive', 'suspended'].includes(user.status))
        throw new ConflictException('Compte désactivé ou suspendu');
      let [kyc] = await m.query(
        'SELECT id FROM kyc_documents WHERE "userId"=$1 ORDER BY "createdAt" DESC,id DESC LIMIT 1',
        [userId],
      );
      if ((kyc?.id ?? null) !== input.kycId)
        throw new ConflictException(
          'Le dossier a changé. Rechargez avant de saisir.',
        );
      if (!kyc) {
        [kyc] = await m.query(
          `INSERT INTO kyc_documents ("userId",provider,status,"providerMetadata")
          VALUES ($1,'legacy','pending','{"channel":"bureau","collection":"manual"}') RETURNING id`,
          [userId],
        );
      }
      const session = `manual:${kyc.id}`;
      await m.query(
        `INSERT INTO kyc_evidence_archives ("kycId","userId","sessionId","captureKind","expiresAt")
        VALUES ($1,$2,$3,'manual',now()+$4::integer*interval '1 day') ON CONFLICT ("kycId","sessionId") DO NOTHING`,
        [kyc.id, userId, session, days],
      );
      const [row] = await m.query(
        `SELECT * FROM kyc_evidence_archives WHERE "kycId"=$1 AND "sessionId"=$2 FOR UPDATE`,
        [kyc.id, session],
      );
      if (
        row.state === 'purged' ||
        (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now())
      )
        throw new ConflictException('Ce dossier manuel est expiré ou révoqué.');
      if (
        row.revision !== input.baseRevision ||
        (row.leaseUntil && new Date(row.leaseUntil).getTime() > Date.now())
      )
        throw new ConflictException(
          'Une autre saisie est en cours ou a été enregistrée. Rechargez le dossier.',
        );
      if (row.objectKeys.length >= 64)
        throw new ConflictException(
          'Limite des révisions atteinte. Contactez le support technique.',
        );
      const token = randomUUID(),
        key = archiveObjectKey(row.id, token);
      await m.query(
        `UPDATE kyc_evidence_archives SET state='processing',"leaseToken"=$2,"leaseUntil"=now()+interval '10 minutes',
        "objectKeys"="objectKeys"||jsonb_build_array($3::text) WHERE id=$1`,
        [row.id, token, key],
      );
      return {
        ...row,
        kycId: kyc.id,
        leaseToken: token,
        objectKeys: [...row.objectKeys, key],
      };
    });
  }
  async finish(row: ArchiveRow, adminId: string): Promise<void> {
    await this.db.transaction(async (m) => {
      const [user] = await m.query(
        'SELECT id,"isActive",status FROM users WHERE id=$1 FOR UPDATE',
        [row.userId],
      );
      const [latest] = await m.query(
        'SELECT id FROM kyc_documents WHERE "userId"=$1 ORDER BY "createdAt" DESC,id DESC LIMIT 1',
        [row.userId],
      );
      if (
        !user?.isActive ||
        ['inactive', 'suspended'].includes(user.status) ||
        latest?.id !== row.kycId
      )
        throw new ConflictException(
          'Le compte ou le dossier a changé pendant la saisie.',
        );
      const rows = await m.query(
        `WITH changed AS (UPDATE kyc_evidence_archives SET state='ready',revision=revision+1,"capturedRevision"=revision+1,
        "objectKey"=$3,"archivedAt"=now(),"leaseToken"=NULL,"leaseUntil"=NULL,"errorCode"=NULL
        WHERE id=$1 AND "leaseToken"=$2 AND revision=$4 AND "kycId"=$5 AND "expiresAt">now() RETURNING id) SELECT id FROM changed`,
        [
          row.id,
          row.leaseToken,
          row.objectKeys[row.objectKeys.length - 1],
          row.revision,
          row.kycId,
        ],
      );
      if (!rows.length)
        throw new ConflictException(
          'La saisie a expiré ou a été révoquée. Rechargez le dossier.',
        );
      await m.query(
        `INSERT INTO kyc_evidence_access_log ("archiveId","adminId",action) VALUES ($1,$2,'manual_save')`,
        [row.id, adminId],
      );
    });
  }
  async release(row: ArchiveRow) {
    await this.db.query(
      `UPDATE kyc_evidence_archives SET state=CASE WHEN "objectKey" IS NULL THEN 'failed' ELSE 'ready' END,
      "leaseUntil"=NULL,"leaseToken"=NULL,"errorCode"='MANUAL_SAVE_FAILED' WHERE id=$1 AND "leaseToken"=$2`,
      [row.id, row.leaseToken],
    );
  }
}
