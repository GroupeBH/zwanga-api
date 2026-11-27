import { randomUUID } from 'node:crypto';
import { DataSource, Table } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { User, UserRole } from '../users/entities/user.entity';
import { ReferralProfile } from '../referrals/entities/referral-profile.entity';
import { AdminReferralsService } from './admin-referrals.service';
import type { SpreadsheetDownload } from './spreadsheet';

const bin = process.env.AUDIT_TEST_POSTGRES_BIN;
// Disposable loopback database; never loads .env or an application connection.
(bin ? describe : describe.skip)(
  'Admin user referrals on isolated PostgreSQL',
  () => {
    let cluster: IsolatedPostgres,
      db: DataSource,
      service: AdminReferralsService;
    beforeAll(async () => {
      cluster = new IsolatedPostgres(bin!);
      db = await cluster.start();
      db.setOptions({ entities: typeOrmEntities });
      await (db as any).buildMetadatas();
      await db.query('CREATE EXTENSION "uuid-ossp"');
      const runner = db.createQueryRunner();
      try {
        for (const entity of [User, ReferralProfile])
          await runner.createTable(
            Table.create(db.getMetadata(entity), db.driver),
            false,
            false,
            false,
          );
      } finally {
        await runner.release();
      }
      service = new AdminReferralsService(
        db.getRepository(User),
        {} as any,
        db.getRepository(ReferralProfile),
        {} as any,
        {} as any,
        {} as any,
      );
    }, 90_000);
    beforeEach(async () => {
      await db.query('TRUNCATE referral_profiles, users');
    });
    afterAll(async () => {
      await cluster?.stop();
    });
    const addUser = (overrides: Partial<User> = {}) =>
      db
        .getRepository(User)
        .save({
          firstName: 'Synthetic',
          lastName: 'Test',
          role: UserRole.PASSENGER,
          createdAt: new Date('2026-11-01T12:00:00Z'),
          ...overrides,
        });
    const attach = (
      parent: User,
      user: User,
      overrides: Partial<ReferralProfile> = {},
    ) =>
      db
        .getRepository(ReferralProfile)
        .save({
          userId: user.id,
          referredByUserId: parent.id,
          code: randomUUID().replaceAll('-', '').slice(0, 16),
          linkToken: randomUUID(),
          referredAt: new Date('2026-11-20T12:00:00Z'),
          ...overrides,
        });
    async function xml(file: SpreadsheetDownload) {
      if ('buffer' in file) return file.buffer.toString('utf8');
      const chunks: Buffer[] = [];
      for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8');
    }
    it('returns direct referrals only, all roles, stable pages and no credential or attribution secrets', async () => {
      const parent = await addUser(),
        other = await addUser();
      const children = await Promise.all(
        Object.values(UserRole).map((role) =>
          addUser({
            role,
            password: 'PRIVATE_PASSWORD',
            fcmToken: `PRIVATE_FCM_${role}`,
          }),
        ),
      );
      for (const child of children)
        await attach(parent, child, {
          attributionAdminReason: 'PRIVATE_REASON',
        });
      await attach(other, await addUser());
      await attach(children[0], await addUser()); // A grandchild is not a direct referral.
      const first = await service.getUserReferrals(parent.id, {
        page: 1,
        limit: 2,
      });
      const second = await service.getUserReferrals(parent.id, {
        page: 2,
        limit: 2,
      });
      expect(first.total).toBe(5);
      expect(second.total).toBe(5);
      expect(first.items).toHaveLength(2);
      expect(
        new Set([...first.items, ...second.items].map((item) => item.user.id))
          .size,
      ).toBe(4);
      expect(JSON.stringify(first)).not.toContain('PRIVATE_');
      const drivers = await service.getUserReferrals(parent.id, {
        page: 1,
        limit: 25,
        role: UserRole.DRIVER,
      });
      expect(drivers.items.map((item) => item.user.id)).toEqual([
        children.find((user) => user.role === UserRole.DRIVER)!.id,
      ]);
      expect(drivers.total).toBe(1);
    });
    it('filters inclusive Kinshasa account creation days, independently of referral attribution dates', async () => {
      const parent = await addUser();
      const start = await addUser({
        role: UserRole.DRIVER,
        createdAt: new Date('2026-11-01T00:00:00+01:00'),
      });
      const end = await addUser({
        role: UserRole.DRIVER,
        createdAt: new Date('2026-11-01T23:59:59.999+01:00'),
      });
      const before = await addUser({
        role: UserRole.DRIVER,
        createdAt: new Date('2026-10-31T23:59:59.999+01:00'),
      });
      const after = await addUser({
        role: UserRole.DRIVER,
        createdAt: new Date('2026-11-02T00:00:00+01:00'),
      });
      const passenger = await addUser();
      for (const child of [start, end, before, after, passenger])
        await attach(parent, child, {
          createdAt: new Date('2026-11-20T12:00:00Z'),
        });
      const filters = {
        page: 2,
        limit: 1,
        role: UserRole.DRIVER,
        registeredFrom: '2026-11-01',
        registeredTo: '2026-11-01',
      };
      const page = await service.getUserReferrals(parent.id, filters);
      expect(page.total).toBe(2);
      expect(page.items.map((item) => item.user.id)).toEqual([start.id]);
      const workbook = await xml(
        await service.exportUserReferrals(parent.id, filters),
      );
      expect(workbook.match(/<Row>/g)).toHaveLength(3);
      expect(workbook).toContain(start.id);
      expect(workbook).toContain(end.id);
      for (const excluded of [before, after, passenger])
        expect(workbook).not.toContain(excluded.id);
      expect(workbook).toContain('Conducteur');
    });
    it('exports all 503 referrals beyond the legacy 50-row preview, displayed page and 500-row batch', async () => {
      const parent = await addUser();
      const rows = Array.from({ length: 503 }, (_, index) => ({
        id: randomUUID(),
        firstName: `Filleul ${index}`,
        lastName: '<Synthetic & test>',
        role: UserRole.PASSENGER,
        createdAt: new Date('2026-11-01T12:00:00Z'),
      }));
      await db.getRepository(User).insert(rows);
      await db
        .getRepository(ReferralProfile)
        .insert(
          rows.map((user, index) => ({
            userId: user.id,
            referredByUserId: parent.id,
            code: `SYN${index}`,
            linkToken: randomUUID(),
            referredAt: new Date('2026-11-20T12:00:00Z'),
          })),
        );
      const filters = { page: 3, limit: 10, role: UserRole.PASSENGER };
      expect(
        (await service.getUserReferrals(parent.id, filters)).items,
      ).toHaveLength(10);
      const workbook = await xml(
        await service.exportUserReferrals(parent.id, filters),
      );
      expect(workbook.match(/<Row>/g)).toHaveLength(504);
      expect(workbook.match(/<Workbook /g)).toHaveLength(1);
      for (const user of rows) expect(workbook).toContain(user.id);
      expect(workbook).toContain('&lt;Synthetic &amp; test&gt;');
      expect(workbook).not.toContain('SYN502');
    }, 60_000);
  },
);
