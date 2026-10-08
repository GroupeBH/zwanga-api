import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { BadRequestException } from '@nestjs/common';
import { DataSource, EntitySchema, Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { saveRegistrationWithPhone } from '../users/registration-phone.policy';

// Explicit opt-in; this never reads application credentials or connects to its DB.
const pgBin = process.env.PHONE_REGISTRATION_TEST_POSTGRES_BIN;
(pgBin ? describe : describe.skip)(
  'registration phone ownership on isolated PostgreSQL',
  () => {
    let directory: string;
    let source: DataSource;
    let users: Repository<User>;
    const phone = '+243890000001';
    const executable = (name: string) =>
      join(pgBin!, process.platform === 'win32' ? `${name}.exe` : name);

    beforeAll(async () => {
      directory = mkdtempSync(
        join(tmpdir(), 'zwanga-phone-registration-test-'),
      );
      execFileSync(
        executable('initdb'),
        [
          '-D',
          directory,
          '-U',
          'registration_test',
          '-A',
          'trust',
          '--no-locale',
          '-E',
          'UTF8',
        ],
        { windowsHide: true, stdio: 'pipe', timeout: 30_000 },
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
        executable('pg_ctl'),
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
        { windowsHide: true, stdio: 'ignore', timeout: 30_000 },
      );
      // Minimal test-only schema with the production phone uniqueness/nullability.
      const schema = new EntitySchema<User>({
        name: 'User',
        target: User,
        tableName: 'users',
        columns: {
          id: { type: 'uuid', primary: true },
          phone: { type: String, nullable: true, unique: true },
          email: { type: String, nullable: true, unique: true },
          firstName: { type: String },
          lastName: { type: String },
          role: { type: String, default: UserRole.PASSENGER },
          status: { type: String, default: UserStatus.PENDING_KYC },
          isActive: { type: Boolean, default: true },
          isPhoneVerified: { type: Boolean, default: false },
          accessToken: { type: String, nullable: true },
          refreshToken: { type: String, nullable: true },
          fcmToken: { type: String, nullable: true },
        },
      });
      source = new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port,
        username: 'registration_test',
        database: 'postgres',
        entities: [schema],
        synchronize: true,
        extra: { max: 4 },
      });
      await source.initialize();
      users = source.getRepository(User);
      await source.query(
        'CREATE TABLE registration_test_history (id uuid PRIMARY KEY, "userId" uuid REFERENCES users(id), amount integer NOT NULL)',
      );
    }, 60_000);

    beforeEach(async () => {
      await source.query('TRUNCATE registration_test_history, users');
    });

    afterAll(async () => {
      try {
        if (source?.isInitialized) await source.destroy();
      } finally {
        // Verify the precise disposable target before stopping/removing it.
        if (
          directory &&
          resolve(directory).startsWith(
            resolve(tmpdir()) + sep + 'zwanga-phone-registration-test-',
          )
        ) {
          if (existsSync(join(directory, 'postmaster.pid'))) {
            execFileSync(
              executable('pg_ctl'),
              ['-D', directory, '-m', 'fast', '-w', 'stop'],
              { windowsHide: true, stdio: 'ignore', timeout: 30_000 },
            );
          }
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }, 40_000);

    function fresh() {
      return users.create({
        id: randomUUID(),
        phone,
        firstName: 'Nouveau',
        lastName: 'Compte',
        role: UserRole.PASSENGER,
        status: UserStatus.PENDING_KYC,
        isActive: true,
        isPhoneVerified: false,
      });
    }

    async function previous(state: { status: UserStatus; isActive: boolean }) {
      return users.save(
        users.create({
          ...fresh(),
          ...state,
          firstName: 'Ancien',
          role: UserRole.DRIVER,
          isPhoneVerified: true,
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          fcmToken: 'old-device',
        }),
      );
    }

    it.each([
      { status: UserStatus.INACTIVE, isActive: false },
      { status: UserStatus.INACTIVE, isActive: true },
      { status: UserStatus.SUSPENDED, isActive: false },
      { status: UserStatus.SUSPENDED, isActive: true },
      { status: UserStatus.ACTIVE, isActive: false },
    ])(
      'releases %j without transferring historical records or verification',
      async (state) => {
        const old = await previous(state);
        const historyId = randomUUID();
        await source.query(
          'INSERT INTO registration_test_history (id, "userId", amount) VALUES ($1, $2, 50)',
          [historyId, old.id],
        );
        const created = await saveRegistrationWithPhone(users, fresh());
        expect(created.id).not.toBe(old.id);
        expect(created).toMatchObject({
          phone,
          isActive: true,
          isPhoneVerified: false,
          role: UserRole.PASSENGER,
        });
        expect(await users.findOneByOrFail({ id: old.id })).toMatchObject({
          phone: null,
          status: state.status,
          role: UserRole.DRIVER,
          isActive: false,
          isPhoneVerified: false,
          accessToken: null,
          refreshToken: null,
          fcmToken: null,
        });
        expect(
          await source.query('SELECT * FROM registration_test_history'),
        ).toEqual([{ id: historyId, userId: old.id, amount: 50 }]);
      },
    );

    it.each([UserStatus.ACTIVE, UserStatus.PENDING_KYC])(
      'preserves an enabled %s owner',
      async (status) => {
        const old = await previous({ status, isActive: true });
        await expect(
          saveRegistrationWithPhone(users, fresh()),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(await users.findOneByOrFail({ id: old.id })).toEqual(old);
        expect(await users.count()).toBe(1);
      },
    );

    it('rolls back the phone release and session revocation if the new account cannot be saved', async () => {
      const old = await previous({
        status: UserStatus.INACTIVE,
        isActive: false,
      });
      await users.save({
        ...fresh(),
        phone: '+243890000002',
        email: 'taken@example.invalid',
      });
      await expect(
        saveRegistrationWithPhone(
          users,
          users.create({ ...fresh(), email: 'taken@example.invalid' }),
        ),
      ).rejects.toMatchObject({ driverError: { code: '23505' } });
      expect(await users.findOneByOrFail({ id: old.id })).toEqual(old);
      expect(await users.count()).toBe(2);
    });

    it('allows exactly one of two concurrent re-registrations', async () => {
      const old = await previous({
        status: UserStatus.SUSPENDED,
        isActive: true,
      });
      const results = await Promise.allSettled([
        saveRegistrationWithPhone(users, fresh()),
        saveRegistrationWithPhone(users, fresh()),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = results.find(
        (result) => result.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(BadRequestException);
      expect(await users.countBy({ phone })).toBe(1);
      expect(await users.count()).toBe(2);
      expect((await users.findOneByOrFail({ id: old.id })).phone).toBeNull();
    });

    it('allows exactly one signup when a deleted account has already released the phone', async () => {
      const deleted = await previous({
        status: UserStatus.INACTIVE,
        isActive: false,
      });
      await users.update(deleted.id, { phone: () => 'NULL' });
      const results = await Promise.allSettled([
        saveRegistrationWithPhone(users, fresh()),
        saveRegistrationWithPhone(users, fresh()),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(await users.countBy({ phone })).toBe(1);
      expect(await users.count()).toBe(2);
    });
  },
);
