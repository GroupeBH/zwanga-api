import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { KycDocument } from '../entities/kyc-document.entity';
import { providerFingerprint } from './didit-archive.policy';
import {
  archiveConfig,
  archiveObjectKey,
  ArchiveRow,
} from './kyc-evidence.policy';

@Injectable()
export class KycEvidenceRepository {
  private readonly logger = new Logger(KycEvidenceRepository.name);
  constructor(
    private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}

  fullDataEnabled() {
    return this.config.get('DIDIT_KYC_ARCHIVE_FULL_DATA_ENABLED') === 'true';
  }

  async enqueue(manager: EntityManager, kyc: KycDocument, payload?: unknown) {
    if (!archiveConfig(this.config)) return;
    // Optional evidence must never abort the business KYC transaction. A plain
    // catch is insufficient in PostgreSQL: a failed statement poisons the TX.
    const transactional = manager.queryRunner?.isTransactionActive === true;
    let savepoint = false;
    try {
      if (transactional) {
        await manager.query('SAVEPOINT didit_evidence_enqueue');
        savepoint = true;
      }
      await this.enqueueRecord(manager, kyc, payload);
      if (savepoint)
        await manager.query('RELEASE SAVEPOINT didit_evidence_enqueue');
    } catch {
      if (savepoint) {
        await manager.query('ROLLBACK TO SAVEPOINT didit_evidence_enqueue');
        await manager.query('RELEASE SAVEPOINT didit_evidence_enqueue');
      }
      this.logger.warn(
        'Optional KYC archive enqueue failed; admin recovery required',
      );
    }
  }

  private async enqueueRecord(
    manager: EntityManager,
    kyc: KycDocument,
    payload?: unknown,
  ) {
    const config = archiveConfig(this.config);
    const full = this.fullDataEnabled();
    if (
      !config ||
      kyc.provider !== 'didit' ||
      !kyc.diditSessionId ||
      (!full &&
        kyc.status !== 'approved' &&
        !['approved', 'declined', 'inreview', 'expired', 'kycexpired'].includes(
          (kyc.diditSessionStatus ?? '').toLowerCase().replace(/[ _-]/g, ''),
        ))
    )
      return;
    if (full) {
      const fingerprint = providerFingerprint(
        payload ?? {
          status: kyc.diditSessionStatus,
          metadata: kyc.providerMetadata,
        },
      );
      await manager.query(
        `INSERT INTO kyc_evidence_archives
        ("kycId","userId","sessionId","expiresAt","sourceFingerprint",revision)
        SELECT $1,$2,$3,now()+NULLIF($4::integer,0)*interval '1 day',$5,1
        FROM users WHERE id=$2 AND "isActive" AND status <> 'inactive'
        ON CONFLICT ("kycId","sessionId") DO UPDATE SET
          "sourceFingerprint"=EXCLUDED."sourceFingerprint", revision=kyc_evidence_archives.revision+1,
          state=CASE WHEN kyc_evidence_archives."leaseUntil">now() THEN kyc_evidence_archives.state
            WHEN jsonb_array_length(kyc_evidence_archives."objectKeys")>=64 THEN 'failed' ELSE 'pending' END,
          attempts=0,"nextAttemptAt"=now(),
          "errorCode"=CASE WHEN jsonb_array_length(kyc_evidence_archives."objectKeys")>=64 THEN 'CAPTURE_LIMIT' ELSE NULL END,
          "exportId"=NULL,"exportRevision"=NULL
        WHERE kyc_evidence_archives."sourceFingerprint" IS DISTINCT FROM EXCLUDED."sourceFingerprint"
          AND kyc_evidence_archives.state <> 'purged'
          AND (kyc_evidence_archives."expiresAt" IS NULL OR kyc_evidence_archives."expiresAt">now())`,
        [kyc.id, kyc.userId, kyc.diditSessionId, config.days, fingerprint],
      );
      return;
    }
    // No provider payload or media URL is persisted in the queue or KYC response.
    await manager.query(
      `INSERT INTO kyc_evidence_archives ("kycId","userId","sessionId","expiresAt")
      SELECT $1,$2,$3,now()+NULLIF($4::integer,0)*interval '1 day' FROM users WHERE id=$2 AND "isActive" AND status <> 'inactive'
      ON CONFLICT ("kycId","sessionId") DO NOTHING`,
      [kyc.id, kyc.userId, kyc.diditSessionId, config.days],
    );
  }

  async claim(): Promise<ArchiveRow | undefined> {
    return this.db.transaction(async (m) => {
      await m.query(`UPDATE kyc_evidence_archives SET state='failed',"errorCode"='RETRIES_EXHAUSTED',"leaseUntil"=NULL,"leaseToken"=NULL
        WHERE "captureKind"='provider' AND state IN ('pending','processing') AND
        (attempts>=CASE WHEN revision>0 THEN 12 ELSE 5 END OR jsonb_array_length("objectKeys")>=64)
        AND ("leaseUntil" IS NULL OR "leaseUntil"<now())`);
      const [row] = await m.query(`SELECT a.* FROM kyc_evidence_archives a
        WHERE "captureKind"='provider' AND state IN ('pending','processing') AND attempts < CASE WHEN revision>0 THEN 12 ELSE 5 END AND "nextAttemptAt" <= now()
        AND jsonb_array_length("objectKeys") < 64
        AND ("leaseUntil" IS NULL OR "leaseUntil" < now()) AND ("expiresAt" IS NULL OR "expiresAt" > now()) AND "kycId" IS NOT NULL
        AND EXISTS (SELECT 1 FROM users u WHERE u.id=a."userId" AND u."isActive" AND u.status <> 'inactive')
        ORDER BY "nextAttemptAt",id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!row) return;
      const token = randomUUID(),
        key = archiveObjectKey(row.id, token);
      await m.query(
        `UPDATE kyc_evidence_archives SET state='processing',attempts=attempts+1,
        "leaseToken"=$2,"leaseUntil"=now()+interval '10 minutes',"objectKeys"="objectKeys" || jsonb_build_array($3::text) WHERE id=$1`,
        [row.id, token, key],
      );
      return {
        ...row,
        leaseToken: token,
        attempts: row.attempts + 1,
        objectKeys: [...row.objectKeys, key],
      };
    });
  }

  async finish(
    row: ArchiveRow,
    state: 'ready' | 'partial' | 'pending' | 'failed',
    objectKey: string | null,
    errorCode: string | null,
  ) {
    if ((row.revision ?? 0) > 0) {
      await this.db.query(
        `UPDATE kyc_evidence_archives SET
        state=CASE WHEN "kycId" IS NULL OR "expiresAt"<=now() THEN 'failed'
          WHEN revision<>$6 THEN 'pending' ELSE $3 END,
        attempts=CASE WHEN revision<>$6 THEN 0 ELSE attempts END,
        "objectKey"=COALESCE($4,"objectKey"),
        "capturedRevision"=CASE WHEN $4::text IS NOT NULL THEN $6 ELSE "capturedRevision" END,
        "errorCode"=CASE WHEN revision<>$6 THEN NULL ELSE $5 END,
        "leaseUntil"=NULL,"leaseToken"=NULL,
        "archivedAt"=CASE WHEN $4::text IS NOT NULL THEN now() ELSE "archivedAt" END,
        "nextAttemptAt"=CASE WHEN revision<>$6 THEN now() ELSE now()+interval '1 minute' END
        WHERE id=$1 AND "leaseToken"=$2`,
        [row.id, row.leaseToken, state, objectKey, errorCode, row.revision],
      );
      return;
    }
    await this.db.query(
      `UPDATE kyc_evidence_archives SET state=CASE WHEN "kycId" IS NULL OR "expiresAt" <= now() THEN 'failed' ELSE $3 END,
      "objectKey"=$4,"errorCode"=$5,"leaseUntil"=NULL,"leaseToken"=NULL,
      "archivedAt"=CASE WHEN $4::text IS NOT NULL THEN now() ELSE "archivedAt" END,
      "nextAttemptAt"=now()+interval '5 minutes' WHERE id=$1 AND "leaseToken"=$2`,
      [row.id, row.leaseToken, state, objectKey, errorCode],
    );
  }

  async saveExport(row: ArchiveRow, exportId: string): Promise<boolean> {
    const rows = await this.db.query(
      `WITH changed AS (UPDATE kyc_evidence_archives SET "exportId"=$3,"exportRevision"=$4
      WHERE id=$1 AND "leaseToken"=$2 AND revision=$4 AND "kycId" IS NOT NULL
      AND ("expiresAt" IS NULL OR "expiresAt">now()) RETURNING id) SELECT id FROM changed`,
      [row.id, row.leaseToken, exportId, row.revision],
    );
    return rows.length === 1;
  }

  async claimPurge(): Promise<ArchiveRow | undefined> {
    return this.db.transaction(async (m) => {
      const [row] =
        await m.query(`SELECT * FROM kyc_evidence_archives WHERE state <> 'purged'
        AND ("kycId" IS NULL OR "userId" IS NULL OR "expiresAt" <= now())
        AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
        ORDER BY "expiresAt",id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!row) return;
      const token = randomUUID();
      await m.query(
        `UPDATE kyc_evidence_archives SET "leaseToken"=$2,"leaseUntil"=now()+interval '10 minutes' WHERE id=$1`,
        [row.id, token],
      );
      return { ...row, leaseToken: token };
    });
  }

  async finishPurge(row: ArchiveRow, succeeded: boolean) {
    if (!succeeded) {
      await this.db.query(
        `UPDATE kyc_evidence_archives SET "errorCode"='ARCHIVE_PURGE_FAILED',"leaseUntil"=now()+interval '5 minutes' WHERE id=$1 AND "leaseToken"=$2`,
        [row.id, row.leaseToken],
      );
      return;
    }
    await this.db.transaction(async (m) => {
      // Keep only a tombstone so repeated webhooks cannot recollect expired data.
      await m.query(
        `WITH changed AS (UPDATE kyc_evidence_archives SET state='purged',"objectKeys"='[]',"objectKey"=NULL,
          "errorCode"=NULL,"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$1 AND "leaseToken"=$2 RETURNING id)
        INSERT INTO kyc_evidence_access_log ("archiveId",action) SELECT id,'purge' FROM changed`,
        [row.id, row.leaseToken],
      );
    });
  }

  list(kycId: string): Promise<ArchiveRow[]> {
    return this.db.query(
      `SELECT id,state,attempts,"errorCode","expiresAt","createdAt","archivedAt",revision,"capturedRevision","captureKind" FROM kyc_evidence_archives WHERE "kycId"=$1 ORDER BY "createdAt" DESC LIMIT 20`,
      [kycId],
    );
  }
  async readable(kycId: string, id: string): Promise<ArchiveRow | undefined> {
    return (
      await this.db.query(
        `SELECT a.* FROM kyc_evidence_archives a JOIN kyc_documents k ON k.id=a."kycId"
      WHERE a.id=$1 AND a."kycId"=$2 AND a."userId"=k."userId" AND (a."expiresAt" IS NULL OR a."expiresAt">now())
      AND (a.state IN ('ready','partial') OR (a."capturedRevision">0 AND a.state IN ('pending','processing')))
      AND a."objectKey" IS NOT NULL`,
        [id, kycId],
      )
    )[0];
  }
  async audit(
    id: string,
    adminId: string,
    action: 'enqueue' | 'read' | 'file',
  ) {
    await this.db.query(
      'INSERT INTO kyc_evidence_access_log ("archiveId","adminId",action) VALUES ($1,$2,$3)',
      [id, adminId, action],
    );
  }
  async request(kycId: string) {
    return this.db.transaction(async (manager) => {
      const kyc = await manager
        .getRepository(KycDocument)
        .findOneBy({ id: kycId });
      if (!kyc) return false;
      await this.enqueue(manager, kyc);
      // Explicit admin recovery only; repeated webhooks never reset attempts or retention.
      await manager.query(
        `UPDATE kyc_evidence_archives SET state='pending',attempts=0,"nextAttemptAt"=now(),"errorCode"=NULL,
        revision=CASE WHEN revision>0 THEN revision+1 ELSE revision END,"exportId"=NULL,"exportRevision"=NULL
        WHERE "captureKind"='provider' AND "kycId"=$1 AND "sessionId"=$2 AND state IN ('failed','partial') AND ("expiresAt" IS NULL OR "expiresAt">now())
        AND ("leaseUntil" IS NULL OR "leaseUntil"<now()) AND jsonb_array_length("objectKeys")<=25`,
        [kyc.id, kyc.diditSessionId],
      );
      return true;
    });
  }
  async expire(kycId: string, id: string, adminId: string) {
    return this.db.transaction(async (m) => {
      const rows = await m.query(
        `WITH changed AS (UPDATE kyc_evidence_archives SET "expiresAt"=LEAST("expiresAt",now())
        WHERE id=$1 AND "kycId"=$2 RETURNING id) SELECT id FROM changed`,
        [id, kycId],
      );
      if (!rows.length) return false;
      await m.query(
        `INSERT INTO kyc_evidence_access_log ("archiveId","adminId",action) VALUES ($1,$2,'purge_request')`,
        [id, adminId],
      );
      return true;
    });
  }
}
