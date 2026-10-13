import { randomUUID } from 'crypto';
import { DataSource, Table } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from './entities';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { KycDocument, KycProvider, KycStatus } from '../users/entities/kyc-document.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { TransactionalNotificationsSubscriber } from '../notifications/transactional-notifications.subscriber';
import { AdminService } from '../admin/admin.service';
import { AwsKycRepository } from '../users/aws-kyc/aws-kyc.repository';
import { KycEvidenceArchive1780000061000 } from './migrations/1780000061000-KycEvidenceArchive';
import { KycEvidenceIndefiniteRetention1780000062000 } from './migrations/1780000062000-KycEvidenceIndefiniteRetention';
import { AwsKycSessions1780000069000 } from './migrations/1780000069000-AwsKycSessions';
import { AwsKycSession } from '../users/aws-kyc/aws-kyc-session.entity';

const bin = process.env.AUDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'AWS KYC on isolated PostgreSQL (no AWS)',
  () => {
    let cluster: IsolatedPostgres, db: DataSource, repo: AwsKycRepository;
    const config = {
      region: 'eu-west-1',
      roleArn: 'unused',
      perUser: 3,
      daily: 2,
      monthly: 2,
      liveness: 95,
      similarity: 95,
      replacePendingDidit: false,
    };
    beforeAll(async () => {
      cluster = new IsolatedPostgres(bin!);
      db = await cluster.start();
      db.setOptions({ entities: typeOrmEntities });
      await (db as any).buildMetadatas();
      await db.query('CREATE EXTENSION "uuid-ossp"');
      const runner = db.createQueryRunner();
      try {
        await runner.createTable(
          Table.create(db.getMetadata(User), db.driver),
          false,
          false,
          false,
        );
        const kycTable = Table.create(db.getMetadata(KycDocument), db.driver);
        kycTable.columns.find((column) => column.name === 'provider')!.enum = [
          'legacy',
          'didit',
        ];
        await runner.createTable(kycTable, false, false, false);
        for (const entity of [Vehicle, Notification]) {
          await runner.createTable(
            Table.create(db.getMetadata(entity), db.driver),
            false,
            false,
            false,
          );
        }
        await runner.query(
          'CREATE UNIQUE INDEX "UQ_notifications_event_key" ON notifications ("eventKey")',
        );
      } finally {
        await runner.release();
      }
      await db.transaction(async (m) => {
        await new KycEvidenceArchive1780000061000().up(m.queryRunner!);
        await new KycEvidenceIndefiniteRetention1780000062000().up(
          m.queryRunner!,
        );
        await new AwsKycSessions1780000069000().up(m.queryRunner!);
      });
      repo = new AwsKycRepository(db);
      new TransactionalNotificationsSubscriber(db);
    }, 90_000);
    beforeEach(async () => {
      await db.query(
        'TRUNCATE aws_kyc_sessions,aws_kyc_budget,kyc_evidence_access_log,kyc_evidence_archives,kyc_documents,notifications,vehicles,users CASCADE',
      );
    });
    afterAll(async () => {
      await cluster?.stop();
    });
    const user = async () =>
      (
        await db
          .getRepository(User)
          .save(
            db
              .getRepository(User)
              .create({ firstName: 'Test', lastName: 'Synthetic' }),
          )
      ).id;
    const reserve = (id: string, request = randomUUID()) =>
      repo.reserve(id, request, 'passport', 'aws-kyc-v1', config);
    const cutover = (id: string, request = randomUUID()) =>
      repo.reserve(id, request, 'passport', 'aws-kyc-v1', { ...config, replacePendingDidit: true });
    const diditDossier = (userId: string, status = KycStatus.PENDING) =>
      db.getRepository(KycDocument).save({ userId, provider: KycProvider.DIDIT, status });

    it('restarts a pending Didit dossier on AWS only after explicit cutover and keeps its history', async () => {
      const id = await user();
      const old = await diditDossier(id);
      await expect(reserve(id)).rejects.toThrow('déjà en cours');
      const { row } = await cutover(id);
      expect((await repo.owned(id, row.id)).kyc.provider).toBe(KycProvider.AWS);
      expect((await db.getRepository(KycDocument).findOneByOrFail({ id: old.id })).status).toBe(KycStatus.PENDING);
      expect(await db.getRepository(KycDocument).countBy({ userId: id })).toBe(2);
      expect(await db.getRepository(Notification).count()).toBe(0);
      await expect(cutover(id)).rejects.toThrow('déjà en cours');
    });

    it('never replaces an approved Didit dossier during cutover', async () => {
      const id = await user();
      await diditDossier(id, KycStatus.APPROVED);
      await expect(cutover(id)).rejects.toThrow('déjà en cours');
      expect(await db.getRepository(AwsKycSession).count()).toBe(0);
    });

    it('serializes concurrent cutover attempts and rolls back a denied quota without changing Didit', async () => {
      const id = await user();
      await diditDossier(id);
      const attempts = await Promise.allSettled([cutover(id), cutover(id)]);
      expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(await db.getRepository(AwsKycSession).count()).toBe(1);
      await reserve(await user()); // Exhaust the two-attempt global budget.
      const blocked = await user();
      const old = await diditDossier(blocked);
      await expect(cutover(blocked)).rejects.toThrow('Limite');
      expect(await db.getRepository(KycDocument).countBy({ userId: blocked })).toBe(1);
      expect((await db.getRepository(KycDocument).findOneByOrFail({ id: old.id })).status).toBe(KycStatus.PENDING);
    });
    const successfulChecks = {
      document: 'consistent',
      names: 'match',
      validity: 'valid',
      ocr: 'confident',
      liveness: 'passed',
      face: 'passed',
    };
    const vehicle = (ownerId: string, isActive = true) =>
      db.getRepository(Vehicle).save({
        ownerId,
        brand: 'Synthetic',
        model: 'Test',
        color: 'Test',
        licensePlate: randomUUID(),
        isActive,
      });
    const finishChecks = async (
      row: AwsKycSession,
      checks = successfulChecks,
    ) => {
      await repo.transition(row, 'compare');
      const claimed = await repo.claim(row.id);
      await repo.transition(claimed!, 'review', checks);
      return repo.owned(row.userId, row.id);
    };

    it.each([false, true])(
      'automatically approves and activates the correct role with a single durable push (vehicle=%s)',
      async (hasVehicle) => {
        const id = await user();
        if (hasVehicle) await vehicle(id);
        const { row } = await reserve(id);
        const saved = await finishChecks(row);
        expect(saved.kyc.status).toBe(KycStatus.APPROVED);
        expect(saved.kyc.providerMetadata).toMatchObject({
          decision: 'automatic',
          manualReviewRequired: false,
        });
        expect(saved.user.status).toBe(UserStatus.ACTIVE);
        expect(saved.user.role).toBe(
          hasVehicle ? UserRole.DRIVER : UserRole.PASSENGER,
        );
        const notification = await db
          .getRepository(Notification)
          .findOneByOrFail({ userId: id });
        expect(notification.data).toMatchObject({
          type: 'kyc_approved',
          role: saved.user.role,
        });
        expect(notification.status).toBe('pending'); // no network send inside the transaction
        expect(await repo.transition(row, 'review', successfulChecks)).toBe(
          false,
        );
        expect(await db.getRepository(Notification).count()).toBe(1);
      },
    );

    it('does not count another owner’s vehicle or an inactive vehicle for driver activation', async () => {
      const id = await user(),
        other = await user();
      await vehicle(other);
      await vehicle(id, false);
      const saved = await finishChecks((await reserve(id)).row);
      expect(saved.user.role).toBe(UserRole.PASSENGER);
    });

    it('keeps uncertain dossiers pending, then processes concurrent manual approvals once', async () => {
      const id = await user();
      await vehicle(id);
      const { row } = await reserve(id);
      const pending = await finishChecks(row, {
        ...successfulChecks,
        names: 'mismatch',
        face: 'review',
      });
      expect(pending.kyc.status).toBe(KycStatus.PENDING);
      expect(pending.user.role).toBe(UserRole.PASSENGER);
      expect(await db.getRepository(Notification).count()).toBe(0);
      const admin = await user();
      await db.getRepository(User).update(admin, { role: UserRole.ADMIN });
      await db.query(
        'INSERT INTO kyc_evidence_access_log ("archiveId","adminId",action) VALUES ($1,$2,\'file\')',
        [row.archiveId, admin],
      );
      const service = Object.assign(Object.create(AdminService.prototype), {
        userRepository: db.getRepository(User),
        kycDocumentRepository: db.getRepository(KycDocument),
        logger: { log: jest.fn(), warn: jest.fn() },
      }) as AdminService;
      await Promise.all(
        [1, 2].map(() =>
          service.verifyKyc(
            row.kycId,
            admin,
            true,
            'Pièce et selfie contrôlés, noms légaux confirmés',
          ),
        ),
      );
      const approved = await repo.owned(id, row.id);
      expect(approved.kyc.providerMetadata?.decision).toBe('manual_approved');
      expect(approved.user.role).toBe(UserRole.DRIVER);
      expect(await db.getRepository(Notification).count()).toBe(1);
    });

    it('rolls back the KYC, role and outbox together if a business transaction fails', async () => {
      const id = await user();
      await vehicle(id);
      const { row } = await reserve(id);
      await expect(
        db.transaction(async (manager) => {
          await manager
            .getRepository(User)
            .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
          const kyc = await manager
            .getRepository(KycDocument)
            .findOneByOrFail({ id: row.kycId });
          kyc.status = KycStatus.APPROVED;
          kyc.reviewedAt = new Date();
          await manager.getRepository(KycDocument).save(kyc);
          expect(
            (await manager.getRepository(User).findOneByOrFail({ id })).role,
          ).toBe(UserRole.DRIVER);
          expect(await manager.getRepository(Notification).count()).toBe(1);
          throw new Error('forced rollback');
        }),
      ).rejects.toThrow('forced rollback');
      const current = await repo.owned(id, row.id);
      expect(current.kyc.status).toBe(KycStatus.PENDING);
      expect(current.user.role).toBe(UserRole.PASSENGER);
      expect(await db.getRepository(Notification).count()).toBe(0);
    });

    it('serializes duplicate create requests into one dossier, archive and budget reservation', async () => {
      const id = await user(),
        request = randomUUID();
      const results = await Promise.all([
        reserve(id, request),
        reserve(id, request),
      ]);
      expect(results.filter((r) => r.fresh)).toHaveLength(1);
      expect(results[0].row.id).toBe(results[1].row.id);
      expect(await db.getRepository(AwsKycSession).count()).toBe(1);
      expect(
        (
          await db.query(
            "SELECT reserved FROM aws_kyc_budget WHERE period LIKE 'day:%'",
          )
        )[0].reserved,
      ).toBe(1);
    });
    it('enforces a global cap under concurrent requests from different accounts', async () => {
      const ids = await Promise.all([user(), user(), user(), user()]);
      const results = await Promise.allSettled(ids.map((id) => reserve(id)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      expect(await db.getRepository(KycDocument).count()).toBe(2);
    });
    it('never returns another owner session and grants a worker only one lease', async () => {
      const id = await user(),
        { row } = await reserve(id);
      await expect(repo.owned(await user(), row.id)).rejects.toThrow();
      await repo.transition(row, 'documents');
      const claims = await Promise.all([
        repo.claim(row.id),
        repo.claim(row.id),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claims.find(Boolean)?.runs).toBe(1);
      expect(await repo.transition(row, 'review')).toBe(false);
    });
    it('invalidates changed legal identity and never revives purged evidence', async () => {
      const id = await user(),
        { row } = await reserve(id);
      await db.getRepository(User).update(id, { firstName: 'Changed' });
      await repo.transition(row, 'documents');
      expect((await repo.owned(id, row.id)).state).toBe('failed');
      expect(
        (await db.getRepository(KycDocument).findOneByOrFail({ id: row.kycId }))
          .status,
      ).toBe('rejected');
    });
    it('retains budget counters and a purge tombstone when an account deletes its KYC', async () => {
      const id = await user(),
        { row } = await reserve(id);
      await db.getRepository(KycDocument).delete(row.kycId);
      expect(await db.getRepository(AwsKycSession).count()).toBe(0);
      expect(
        (await db.query('SELECT "kycId" FROM kyc_evidence_archives'))[0].kycId,
      ).toBeNull();
      expect(
        (await db.query('SELECT reserved FROM aws_kyc_budget'))[0].reserved,
      ).toBe(1);
    });
  },
);
