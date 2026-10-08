import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { DataSource } from 'typeorm';
import { KycEvidenceArchive1780000061000 } from './migrations/1780000061000-KycEvidenceArchive';
import { KycEvidenceIndefiniteRetention1780000062000 } from './migrations/1780000062000-KycEvidenceIndefiniteRetention';
import { KycEvidenceRepository } from '../users/kyc-evidence/kyc-evidence.repository';

// Explicit local disposable cluster only: never loads an application .env.
const bin = process.env.KYC_EVIDENCE_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'KYC evidence queue on isolated PostgreSQL',
  () => {
    let directory: string, db: DataSource, repository: KycEvidenceRepository;
    const user = randomUUID(),
      kycId = randomUUID(),
      sessionId = randomUUID();
    const config = {
      DIDIT_KYC_ARCHIVE_ENABLED: 'true',
      DIDIT_KYC_ARCHIVE_RETENTION_DAYS: '30',
      DIDIT_KYC_MEDIA_HOSTS: 'media.didit.test',
      AWS_S3_BUCKET_NAME: 'synthetic-private',
      DIDIT_API_KEY: 'synthetic',
    };
    const exe = (name: string) =>
      join(bin!, process.platform === 'win32' ? `${name}.exe` : name);
    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'zwanga-kyc-evidence-test-'));
      execFileSync(
        exe('initdb'),
        [
          '-D',
          directory,
          '-U',
          'evidence_test',
          '-A',
          'trust',
          '--no-locale',
          '-E',
          'UTF8',
        ],
        { windowsHide: true, stdio: 'pipe', timeout: 30000 },
      );
      const port = await new Promise<number>((done, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const port = (server.address() as { port: number }).port;
          server.close(() => done(port));
        });
      });
      execFileSync(
        exe('pg_ctl'),
        [
          '-D',
          directory,
          '-l',
          join(directory, 'postgres.log'),
          '-o',
          `-h 127.0.0.1 -p ${port}`,
          '-w',
          'start',
        ],
        { windowsHide: true, stdio: 'ignore', timeout: 30000 },
      );
      db = new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port,
        username: 'evidence_test',
        database: 'postgres',
        extra: { max: 5 },
      });
      await db.initialize();
      await db.query(`CREATE EXTENSION "uuid-ossp";
      CREATE TABLE users (id uuid PRIMARY KEY,"isActive" boolean DEFAULT true,status text DEFAULT 'active');
      CREATE TABLE kyc_documents (id uuid PRIMARY KEY,"userId" uuid REFERENCES users(id),status text DEFAULT 'approved');`);
      await db.transaction((m) =>
        new KycEvidenceArchive1780000061000().up(m.queryRunner!),
      );
      await db.transaction((m) =>
        new KycEvidenceIndefiniteRetention1780000062000().up(m.queryRunner!),
      );
      repository = new KycEvidenceRepository(db, {
        get: (key: string) => config[key],
      } as any);
    }, 60000);
    beforeEach(async () => {
      config.DIDIT_KYC_ARCHIVE_RETENTION_DAYS = '30';
      await db.query(
        'TRUNCATE kyc_evidence_access_log,kyc_evidence_archives,kyc_documents,users',
      );
      await db.query('INSERT INTO users(id) VALUES ($1)', [user]);
      await db.query('INSERT INTO kyc_documents(id,"userId") VALUES ($1,$2)', [
        kycId,
        user,
      ]);
    });
    afterAll(async () => {
      try {
        if (db?.isInitialized) await db.destroy();
      } finally {
        if (
          directory &&
          resolve(directory).startsWith(
            resolve(tmpdir()) + sep + 'zwanga-kyc-evidence-test-',
          )
        ) {
          if (existsSync(join(directory, 'postmaster.pid')))
            execFileSync(
              exe('pg_ctl'),
              ['-D', directory, '-m', 'fast', '-w', 'stop'],
              { windowsHide: true, stdio: 'ignore', timeout: 30000 },
            );
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }, 40000);
    const enqueue = () =>
      db.transaction((m) =>
        repository.enqueue(m, {
          id: kycId,
          userId: user,
          diditSessionId: sessionId,
          provider: 'didit',
          status: 'approved',
          diditSessionStatus: 'Approved',
        } as any),
      );

    it('deduplicates repeated/concurrent events without extending retention', async () => {
      await Promise.all([enqueue(), enqueue(), enqueue()]);
      const before = await repository.list(kycId);
      expect(before).toHaveLength(1);
      await enqueue();
      expect(await repository.list(kycId)).toEqual(before);
      expect(
        (await db.query('SELECT status FROM kyc_documents'))[0].status,
      ).toBe('approved');
    });
    it('only one worker claims a given session and records the planned key before upload', async () => {
      await enqueue();
      const claims = await Promise.all([
        repository.claim(),
        repository.claim(),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const [row] = await db.query('SELECT * FROM kyc_evidence_archives');
      expect(row.attempts).toBe(1);
      expect(row.objectKeys).toHaveLength(1);
      expect(row.objectKeys[0]).toContain(row.leaseToken);
    });
    it('never exposes archives belonging to a different KYC dossier', async () => {
      await enqueue();
      const row = (await repository.claim())!;
      await repository.finish(row, 'ready', row.objectKeys[0], null);
      expect(await repository.readable(kycId, row.id)).toBeDefined();
      expect(await repository.readable(randomUUID(), row.id)).toBeUndefined();
    });
    it('fences a stalled worker after its lease has been reclaimed', async () => {
      await enqueue();
      const old = (await repository.claim())!;
      await db.query(
        `UPDATE kyc_evidence_archives SET "leaseUntil"=now()-interval '1 second'`,
      );
      const current = (await repository.claim())!;
      expect(current.attempts).toBe(2);
      expect(current.objectKeys).toHaveLength(2);
      await repository.finish(old, 'ready', old.objectKeys[0], null);
      expect((await repository.list(kycId))[0].state).toBe('processing');
      await repository.finish(current, 'ready', current.objectKeys[1], null);
      expect((await repository.readable(kycId, current.id))?.objectKey).toBe(
        current.objectKeys[1],
      );
    });
    it('keeps a durable cleanup record after account KYC deletion during upload', async () => {
      await enqueue();
      const row = (await repository.claim())!;
      await db.query('DELETE FROM kyc_documents WHERE id=$1', [kycId]);
      expect(await repository.readable(kycId, row.id)).toBeUndefined();
      expect(await repository.claimPurge()).toBeUndefined(); // let the bounded in-flight upload end
      await repository.finish(row, 'ready', row.objectKeys[0], null);
      const purge = (await repository.claimPurge())!;
      expect(purge.kycId).toBeNull();
      expect(purge.objectKeys).toEqual(row.objectKeys);
      await repository.finishPurge(purge, true);
      expect(
        (
          await db.query('SELECT state,"objectKeys" FROM kyc_evidence_archives')
        )[0],
      ).toEqual({ state: 'purged', objectKeys: [] });
    });
    it('revokes access immediately on explicit purge and never recollects after expiration', async () => {
      await enqueue();
      const row = (await repository.claim())!;
      await repository.finish(row, 'ready', row.objectKeys[0], null);
      expect(await repository.expire(kycId, row.id, user)).toBe(true);
      expect(await repository.readable(kycId, row.id)).toBeUndefined();
      await repository.finishPurge((await repository.claimPurge())!, true);
      await enqueue();
      expect((await repository.list(kycId))[0].state).toBe('purged');
      expect(await repository.claim()).toBeUndefined();
    });
    it('retains object keys and a bounded delay when cleanup fails', async () => {
      await enqueue();
      const row = (await repository.claim())!;
      await repository.finish(row, 'failed', null, 'CAPTURE_FAILED');
      await repository.expire(kycId, row.id, user);
      const purge = (await repository.claimPurge())!;
      await repository.finishPurge(purge, false);
      expect(await repository.claimPurge()).toBeUndefined();
      const [saved] = await db.query('SELECT * FROM kyc_evidence_archives');
      expect(saved.objectKeys).toEqual(row.objectKeys);
      expect(saved.errorCode).toBe('ARCHIVE_PURGE_FAILED');
    });
    it('marks an exhausted crashed attempt failed instead of leaving processing forever', async () => {
      await enqueue();
      await repository.claim();
      await db.query(
        `UPDATE kyc_evidence_archives SET attempts=5,"leaseUntil"=now()-interval '1 second'`,
      );
      expect(await repository.claim()).toBeUndefined();
      expect((await repository.list(kycId))[0].state).toBe('failed');
    });
    it('does not collect after user deactivation', async () => {
      await enqueue();
      await db.query('UPDATE users SET "isActive"=false');
      expect(await repository.claim()).toBeUndefined();
    });
    it('keeps zero-day archives readable indefinitely without scheduling age-based purge', async () => {
      config.DIDIT_KYC_ARCHIVE_RETENTION_DAYS = '0';
      await enqueue();
      expect((await repository.list(kycId))[0].expiresAt).toBeNull();
      const row = (await repository.claim())!;
      expect(row.expiresAt).toBeNull();
      await repository.finish(row, 'ready', row.objectKeys[0], null);
      await db.query(
        `UPDATE kyc_evidence_archives SET "createdAt"=now()-interval '100 years',"archivedAt"=now()-interval '100 years'`,
      );
      expect(await repository.readable(kycId, row.id)).toBeDefined();
      expect(await repository.claimPurge()).toBeUndefined();
    });
    it('explicitly deletes an indefinite archive without allowing recollection', async () => {
      config.DIDIT_KYC_ARCHIVE_RETENTION_DAYS = '0';
      await enqueue();
      const row = (await repository.claim())!;
      await repository.finish(row, 'ready', row.objectKeys[0], null);
      expect(await repository.expire(kycId, row.id, user)).toBe(true);
      expect(await repository.readable(kycId, row.id)).toBeUndefined();
      expect((await repository.list(kycId))[0].expiresAt).not.toBeNull();
      await repository.finishPurge((await repository.claimPurge())!, true);
      await enqueue();
      expect((await repository.list(kycId))[0].state).toBe('purged');
      expect(await repository.claim()).toBeUndefined();
    });
    it('still purges an indefinite archive when its KYC dossier is deleted', async () => {
      config.DIDIT_KYC_ARCHIVE_RETENTION_DAYS = '0';
      await enqueue();
      const row = (await repository.claim())!;
      await repository.finish(row, 'ready', row.objectKeys[0], null);
      await db.query('DELETE FROM kyc_documents WHERE id=$1', [kycId]);
      expect(await repository.readable(kycId, row.id)).toBeUndefined();
      const purge = (await repository.claimPurge())!;
      expect(purge.id).toBe(row.id);
      await repository.finishPurge(purge, true);
      expect(
        (await db.query('SELECT state FROM kyc_evidence_archives'))[0].state,
      ).toBe('purged');
    });
    it('preserves existing finite deadlines across migration, config changes and repeated webhooks', async () => {
      await enqueue();
      const before = await repository.list(kycId);
      config.DIDIT_KYC_ARCHIVE_RETENTION_DAYS = '0';
      await db.transaction((m) =>
        new KycEvidenceIndefiniteRetention1780000062000().up(m.queryRunner!),
      );
      await enqueue();
      expect(await repository.list(kycId)).toEqual(before);
    });
  },
);
