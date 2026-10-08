import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { KycDocument } from '../entities/kyc-document.entity';
import {
  archiveConfig,
  archiveObjectKey,
  ArchiveRow,
} from './kyc-evidence.policy';

@Injectable()
export class KycEvidenceRepository {
  constructor(
    private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}

  async enqueue(manager: EntityManager, kyc: KycDocument) {
    const config = archiveConfig(this.config);
    if (
      !config ||
      kyc.provider !== 'didit' ||
      !kyc.diditSessionId ||
      (kyc.status !== 'approved' &&
        !['approved', 'declined', 'inreview', 'expired', 'kycexpired'].includes(
          (kyc.diditSessionStatus ?? '').toLowerCase().replace(/[ _-]/g, ''),
        ))
    )
      return;
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
        WHERE state='processing' AND attempts=5 AND "leaseUntil"<now()`);
      const [row] = await m.query(`SELECT a.* FROM kyc_evidence_archives a
        WHERE state IN ('pending','processing') AND attempts < 5 AND "nextAttemptAt" <= now()
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
    await this.db.query(
      `UPDATE kyc_evidence_archives SET state=CASE WHEN "kycId" IS NULL OR "expiresAt" <= now() THEN 'failed' ELSE $3 END,
      "objectKey"=$4,"errorCode"=$5,"leaseUntil"=NULL,"leaseToken"=NULL,
      "archivedAt"=CASE WHEN $4::text IS NOT NULL THEN now() ELSE "archivedAt" END,
      "nextAttemptAt"=now()+interval '5 minutes' WHERE id=$1 AND "leaseToken"=$2`,
      [row.id, row.leaseToken, state, objectKey, errorCode],
    );
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
      `SELECT id,state,attempts,"errorCode","expiresAt","createdAt","archivedAt" FROM kyc_evidence_archives WHERE "kycId"=$1 ORDER BY "createdAt" DESC LIMIT 20`,
      [kycId],
    );
  }
  async readable(kycId: string, id: string): Promise<ArchiveRow | undefined> {
    return (
      await this.db.query(
        `SELECT a.* FROM kyc_evidence_archives a JOIN kyc_documents k ON k.id=a."kycId"
      WHERE a.id=$1 AND a."kycId"=$2 AND a."userId"=k."userId" AND (a."expiresAt" IS NULL OR a."expiresAt">now())
      AND a.state IN ('ready','partial') AND a."objectKey" IS NOT NULL`,
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
        `UPDATE kyc_evidence_archives SET state='pending',attempts=0,"nextAttemptAt"=now(),"errorCode"=NULL
        WHERE "kycId"=$1 AND "sessionId"=$2 AND state IN ('failed','partial') AND ("expiresAt" IS NULL OR "expiresAt">now())
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
