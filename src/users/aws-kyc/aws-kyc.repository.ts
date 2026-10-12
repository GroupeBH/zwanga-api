import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import { User, UserStatus } from '../entities/user.entity';
import {
  KycDocument,
  KycProvider,
  KycStatus,
} from '../entities/kyc-document.entity';
import { archiveObjectKey } from '../kyc-evidence/kyc-evidence.policy';
import { AwsKycSession } from './aws-kyc-session.entity';
import {
  awsKycConfig,
  AwsDocumentType,
  AwsKycState,
  identityHash,
  awsKycDecision,
  AWS_KYC_DECISION_VERSION,
} from './aws-kyc.policy';

@Injectable()
export class AwsKycRepository {
  constructor(private readonly db: DataSource) {}

  async owned(userId: string, id?: string) {
    const row = await this.db.getRepository(AwsKycSession).findOne({
      where: { userId, ...(id ? { id } : {}) },
      relations: ['kyc', 'user'],
      order: { createdAt: 'DESC' },
    });
    if (
      !row ||
      !row.user.isActive ||
      [UserStatus.INACTIVE, UserStatus.SUSPENDED].includes(row.user.status)
    )
      throw new NotFoundException('Dossier KYC introuvable.');
    return row;
  }

  async reserve(
    userId: string,
    requestId: string,
    documentType: AwsDocumentType,
    consentVersion: string,
    config: NonNullable<ReturnType<typeof awsKycConfig>>,
  ) {
    return this.db.transaction(async (m) => {
      const user = await m.getRepository(User).findOne({
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !user?.isActive ||
        [UserStatus.INACTIVE, UserStatus.SUSPENDED].includes(user.status)
      )
        throw new ForbiddenException('Compte indisponible.');
      if (!user.firstName?.trim() || !user.lastName?.trim())
        throw new BadRequestException(
          'Complétez vos noms légaux dans votre profil.',
        );
      const repo = m.getRepository(AwsKycSession);
      const prior = await repo.findOneBy({ userId, requestId });
      if (prior) {
        if (prior.documentType !== documentType)
          throw new ConflictException(
            'Cette demande a déjà été utilisée pour une autre pièce.',
          );
        return { row: prior, user, fresh: false };
      }
      const latest = await m
        .getRepository(KycDocument)
        .findOne({ where: { userId }, order: { createdAt: 'DESC' } });
      if (latest && latest.status !== KycStatus.REJECTED)
        throw new ConflictException(
          'Un dossier est déjà en cours ou approuvé.',
        );
      // Close a previous administrative rejection before allowing a new attempt.
      await repo
        .createQueryBuilder()
        .update()
        .set({
          state: 'failed',
          errorCode: 'REJECTED',
          leaseToken: null,
          leaseUntil: null,
        })
        .where(
          '"userId" = :userId AND "kycId" IN (SELECT id FROM kyc_documents WHERE status = :status)',
          { userId, status: KycStatus.REJECTED },
        )
        .execute();
      const now = new Date(),
        date = now.toISOString().slice(0, 10);
      // Atomic, persistent reservations across ECS tasks and account/document deletion.
      // The small budget table deliberately uses parameterized UPSERTs.
      for (const [period, limit] of [
        [`month:${date.slice(0, 7)}`, config.monthly],
        [`day:${date}`, config.daily],
        [`user:${userId}:${date}`, config.perUser],
      ] as const) {
        const rows = await m.query(
          `INSERT INTO aws_kyc_budget(period,reserved) VALUES($1,1)
          ON CONFLICT(period) DO UPDATE SET reserved=aws_kyc_budget.reserved+1
          WHERE aws_kyc_budget.reserved<$2 RETURNING reserved`,
          [period, limit],
        );
        if (!rows.length)
          throw new ServiceUnavailableException(
            'Limite de vérifications atteinte. Réessayez plus tard ou contactez le support.',
          );
      }
      const kyc = await m.getRepository(KycDocument).save(
        m.getRepository(KycDocument).create({
          userId,
          provider: KycProvider.AWS,
          status: KycStatus.PENDING,
        }),
      );
      const id = randomUUID(),
        archiveId = randomUUID(),
        token = randomUUID(),
        key = archiveObjectKey(archiveId, token);
      // 'failed' prevents the Didit collector from claiming this AWS-owned archive.
      // The existing purge worker still owns erasure, including abandoned uploads.
      await m.query(
        `INSERT INTO kyc_evidence_archives(id,"kycId","userId","sessionId",state,"expiresAt","objectKeys","leaseUntil")
        VALUES($1,$2,$3,$4,'failed',NULL,$5::jsonb,now()+interval '5 minutes')`,
        [archiveId, kyc.id, userId, id, JSON.stringify([key])],
      );
      const row = await repo.save(
        repo.create({
          id,
          userId,
          kycId: kyc.id,
          requestId,
          archiveId,
          documentType,
          identityHash: identityHash(user.firstName, user.lastName),
          consentVersion,
          state: 'uploading',
          objectKey: key,
          region: config.region,
          expiresAt: new Date(now.getTime() + 30 * 60_000),
          leaseToken: token,
          leaseUntil: new Date(now.getTime() + 2 * 60_000),
          checks: {},
          failures: 0,
        }),
      );
      return { row, user, fresh: true };
    });
  }

  async transition(
    row: AwsKycSession,
    state: AwsKycState,
    checks = row.checks,
    objectKey = row.objectKey,
    errorCode: string | null = null,
  ) {
    return this.db.transaction(async (m) => {
      // Same order as admin/delete: user -> KYC -> session -> archive.
      const user = await m.getRepository(User).findOne({
        where: { id: row.userId },
        lock: { mode: 'pessimistic_write' },
      });
      const kyc = await m.getRepository(KycDocument).findOne({
        where: { id: row.kycId },
        lock: { mode: 'pessimistic_write' },
      });
      const current = await m.getRepository(AwsKycSession).findOne({
        where: { id: row.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current || current.leaseToken !== row.leaseToken) return false;
      const [archive] = await m.query(
        'SELECT * FROM kyc_evidence_archives WHERE id=$1 FOR UPDATE',
        [row.archiveId],
      );
      if (
        !user?.isActive ||
        [UserStatus.INACTIVE, UserStatus.SUSPENDED].includes(user.status) ||
        !kyc ||
        kyc.status !== KycStatus.PENDING ||
        archive?.state === 'purged' ||
        archive?.expiresAt
      ) {
        await m.getRepository(AwsKycSession).update(row.id, {
          state: 'failed',
          errorCode: 'UNAVAILABLE',
          leaseToken: null,
          leaseUntil: null,
        });
        if (kyc?.status === KycStatus.PENDING) {
          kyc.status = KycStatus.REJECTED;
          kyc.rejectionReason =
            'Vérification interrompue. Contactez le support ou recommencez depuis votre profil.';
          kyc.reviewedAt = new Date();
          await m.getRepository(KycDocument).save(kyc);
        }
        return false;
      }
      if (identityHash(user.firstName, user.lastName) !== row.identityHash) {
        state = 'failed';
        errorCode = 'IDENTITY_CHANGED';
      }
      await m.getRepository(AwsKycSession).update(row.id, {
        state,
        checks,
        objectKey,
        errorCode,
        failures: 0,
        runs: state === row.state ? row.runs : 0,
        leaseToken: null,
        leaseUntil: null,
        nextAttemptAt: new Date(
          Date.now() + (state === 'liveness' ? 10_000 : 0),
        ),
        ...(state === 'compare'
          ? { expiresAt: new Date(Date.now() + 30 * 60_000) }
          : {}),
      });
      if (state === 'review' || state === 'failed') {
        const decision = state === 'review' ? awsKycDecision(checks) : null;
        if (decision?.mode === 'automatic') {
          kyc.status = KycStatus.APPROVED;
          kyc.reviewedAt = new Date();
          kyc.reviewedBy = null;
          kyc.rejectionReason = null;
        }
        if (state === 'failed') {
          kyc.status = KycStatus.REJECTED;
          kyc.rejectionReason =
            'Vérification non finalisée. Consultez votre parcours KYC ou contactez le support.';
          kyc.reviewedAt = new Date();
        }
        // Only non-sensitive summary. OCR, names and biometric scores stay in the encrypted archive.
        kyc.providerMetadata = {
          awsSessionId: row.id,
          state,
          manualReviewRequired: decision?.mode === 'manual_review',
          decision: decision?.mode ?? 'capture_failed',
          decisionVersion: AWS_KYC_DECISION_VERSION,
          reviewReasons: decision?.reasons ?? [],
          document: checks.document,
          names: checks.names,
          validity: checks.validity,
          ocr: checks.ocr,
          liveness: checks.liveness,
          face: checks.face,
        };
        await m.getRepository(KycDocument).save(kyc);
        await m.query(
          `UPDATE kyc_evidence_archives SET state=$2,"objectKey"=$3,"archivedAt"=now(),"leaseUntil"=NULL WHERE id=$1`,
          [row.archiveId, state === 'review' ? 'ready' : 'partial', objectKey],
        );
      }
      return true;
    });
  }

  async claim(id?: string): Promise<AwsKycSession | null> {
    return this.db.transaction(async (m) => {
      const q = m
        .getRepository(AwsKycSession)
        .createQueryBuilder('s')
        .where("s.state IN ('documents','liveness','compare')")
        .andWhere(
          's."nextAttemptAt" <= now() AND (s."leaseUntil" IS NULL OR s."leaseUntil" < now())',
        )
        .orderBy("CASE WHEN s.state = 'liveness' THEN 0 ELSE 1 END", 'ASC')
        .addOrderBy('s.nextAttemptAt', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked');
      if (id) q.andWhere('s.id = :id', { id });
      const row = await q.getOne();
      if (!row) return null;
      if (['documents', 'compare'].includes(row.state)) row.runs++;
      return this.lease(m, row);
    });
  }

  async claimExpired() {
    return this.db.transaction(async (m) => {
      const row = await m
        .getRepository(AwsKycSession)
        .createQueryBuilder('s')
        .where("s.state NOT IN ('review','failed')")
        .andWhere(
          '(s."expiresAt" < now() OR (s.state = :uploading AND s."leaseUntil" < now()))',
          { uploading: 'uploading' },
        )
        .andWhere('(s."leaseUntil" IS NULL OR s."leaseUntil" < now())')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getOne();
      return row ? this.lease(m, row) : null;
    });
  }

  async start(userId: string, id: string) {
    return this.db.transaction(async (m) => {
      const row = await m.getRepository(AwsKycSession).findOne({
        where: { id, userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new NotFoundException('Dossier KYC introuvable.');
      if (row.expiresAt.getTime() <= Date.now())
        throw new ConflictException(
          'Session expirée. Recommencez la vérification.',
        );
      if (row.state === 'liveness' && row.livenessId)
        return { row, fresh: false };
      if (
        !['ready', 'creating'].includes(row.state) ||
        (row.leaseUntil && row.leaseUntil.getTime() > Date.now())
      )
        throw new ConflictException(
          'Vérification en cours. Réessayez dans un instant.',
        );
      if (row.state === 'ready') row.expiresAt = new Date(Date.now() + 175_000);
      row.state = 'creating';
      return { row: await this.lease(m, row), fresh: true };
    });
  }

  async setLiveness(row: AwsKycSession, livenessId: string) {
    return this.db.getRepository(AwsKycSession).update(
      { id: row.id, state: 'creating', leaseToken: row.leaseToken! },
      {
        livenessId,
        state: 'liveness',
        leaseToken: null,
        leaseUntil: null,
        nextAttemptAt: new Date(Date.now() + 10_000),
      },
    );
  }

  private async lease(m: EntityManager, row: AwsKycSession) {
    row.leaseToken = randomUUID();
    row.leaseUntil = new Date(Date.now() + 120_000);
    await m.getRepository(AwsKycSession).save(row);
    // Claim only the queue row. Locking the archive here would invert the
    // account-deletion lock order. snapshotKey protects each actual S3 write.
    return row;
  }

  async snapshotKey(row: AwsKycSession) {
    const key = archiveObjectKey(row.archiveId, randomUUID());
    const rows = await this.db.query(
      `UPDATE kyc_evidence_archives a SET "objectKeys"="objectKeys" || jsonb_build_array($3::text),"leaseUntil"=now()+interval '5 minutes'
      WHERE a.id=$1 AND a.state <> 'purged' AND a."expiresAt" IS NULL AND a."kycId" IS NOT NULL
      AND EXISTS (SELECT 1 FROM aws_kyc_sessions s WHERE s.id=$2 AND s."leaseToken"=$4 AND s."leaseUntil">now()) RETURNING a.id`,
      [row.archiveId, row.id, key, row.leaseToken],
    );
    if (!rows.length) throw new Error('SESSION_UNAVAILABLE');
    return key;
  }

  async retry(row: AwsKycSession) {
    if (row.failures >= 2)
      return this.transition(
        row,
        'failed',
        row.checks,
        row.objectKey,
        'SERVICE_UNAVAILABLE',
      );
    await this.db.getRepository(AwsKycSession).update(
      { id: row.id, leaseToken: row.leaseToken! },
      {
        failures: row.failures + 1,
        leaseToken: null,
        leaseUntil: null,
        nextAttemptAt: new Date(Date.now() + 10_000 * (row.failures + 1)),
      },
    );
  }
}
