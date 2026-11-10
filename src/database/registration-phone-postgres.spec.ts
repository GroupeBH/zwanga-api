import { execFileSync } from 'child_process';
import { postgresTestServerOptions } from '../../test/postgres-test-options';
import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { BadRequestException } from '@nestjs/common';
import { DataSource, EntitySchema, Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { saveRegistrationWithPhone } from '../users/registration-phone.policy';
import { CanonicalPhoneIdentity1780000119000 } from './migrations/1780000119000-CanonicalPhoneIdentity';
import { accountPhoneWhere, canonicalAccountPhone } from '../users/phone-identity';
import { AuthService } from '../auth/auth.service';

// Explicit opt-in; this never reads application credentials or connects to its DB.
const pgBin = process.env.PHONE_REGISTRATION_TEST_POSTGRES_BIN;
(pgBin ? describe : describe.skip)(
  'registration phone ownership on isolated PostgreSQL',
  () => {
    let directory: string;
    let source: DataSource;
    let users: Repository<User>;
    const phone = '+243890000001';
    const identityMigration = new CanonicalPhoneIdentity1780000119000();
    async function migrate(direction: 'up' | 'down') {
      const runner = source.createQueryRunner();
      try { await identityMigration[direction](runner); }
      finally { await runner.release(); }
    }
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
          '--no-sync', // Disposable cluster only; avoid slow Windows disk sync.
        ],
        { windowsHide: true, stdio: 'pipe', timeout: process.platform === 'win32' ? 120_000 : 30_000 },
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
          postgresTestServerOptions(port),
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
      await migrate('up');
      users = source.getRepository(User);
      await source.query(
        'CREATE TABLE registration_test_history (id uuid PRIMARY KEY, "userId" uuid REFERENCES users(id), amount integer NOT NULL)',
      );
    }, process.platform === 'win32' ? 180_000 : 60_000);

    beforeEach(async () => {
      await source.query('TRUNCATE registration_test_history, users, user_phone_identities');
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

    it.each(['0890000001', '890000001', '243890000001', '00243890000001', '+243 890-000-001'])('stores %s canonically and finds it through every login spelling', async input => {
      const account = await users.save({ ...fresh(), phone: input });
      expect((await users.findOneByOrFail({ id: account.id })).phone).toBe(phone);
      for (const spelling of [input, phone, '0890000001']) {
        expect((await users.findOneByOrFail({ phone: accountPhoneWhere(spelling) })).id).toBe(account.id);
      }
    });

    it.each(['+32 2 000 00 00', '00352 26 00 00', '+2250100000000', '+390600000000', '0900000000'])('keeps SQL and OTP normalization aligned for %s', async input => {
      const [row] = await source.query('SELECT public.zwanga_canonical_phone($1) AS phone', [input]);
      expect(row.phone).toBe(canonicalAccountPhone(input));
    });

    it('prevents concurrent alias signups even outside the registration service', async () => {
      const results = await Promise.allSettled([
        users.save({ ...fresh(), phone: '0890000001' }),
        users.save({ ...fresh(), phone }),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
      expect(await users.count()).toBe(1);
    });

    it('uses the same Unicode whitespace rules in PostgreSQL and OTP', async () => {
      for (const code of [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) {
        const input = `+243${String.fromCharCode(code)}890000001`;
        const [row] = await source.query('SELECT public.zwanga_canonical_phone($1) AS phone', [input]);
        expect(row.phone).toBe(canonicalAccountPhone(input));
      }
    });

    it('rejects malformed writes and releases a deleted account reservation', async () => {
      await expect(users.save({ ...fresh(), phone: 'not a phone' })).rejects
        .toMatchObject({ driverError: { code: '23514', constraint: 'CHK_users_phone_identity' } });
      const first = await users.save(fresh());
      await users.delete(first.id);
      expect(await source.query('SELECT * FROM user_phone_identities')).toEqual([]);
      const second = await users.save({ ...fresh(), phone: '0890000001' });
      expect((await users.findOneByOrFail({ phone: accountPhoneWhere(phone) })).id).toBe(second.id);
    });

    it('serializes alias registrations and preserves the canonical error contract', async () => {
      const results = await Promise.allSettled([
        saveRegistrationWithPhone(users, users.create({ ...fresh(), phone: '0890000001' })),
        saveRegistrationWithPhone(users, fresh()),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason)
        .toMatchObject({ response: { code: 'PHONE_ALREADY_REGISTERED' } });
    });

    it('rejects a phone change to an occupied alias and rolls its old reservation back', async () => {
      const first = await users.save(fresh());
      const second = await users.save({ ...fresh(), phone: '+243890000002' });
      await expect(users.update(second.id, { phone: '0890000001' })).rejects
        .toMatchObject({ driverError: { code: '23505', constraint: 'UQ_users_phone_identity' } });
      expect((await users.findOneByOrFail({ id: second.id })).phone).toBe('+243890000002');
      expect(await source.query('SELECT "userId" FROM user_phone_identities ORDER BY phone'))
        .toEqual([{ userId: first.id }, { userId: second.id }]);
    });

    it('preserves and quarantines historical collisions, including an inactive owner', async () => {
      await migrate('down');
      const first = await users.save({ ...fresh(), phone: '0890000001', status: UserStatus.INACTIVE });
      const second = await users.save(fresh());
      const historyId = randomUUID();
      await source.query('INSERT INTO registration_test_history VALUES ($1,$2,50)', [historyId, first.id]);
      await migrate('up');
      expect((await users.findOneByOrFail({ id: first.id })).phone).toBe('0890000001');
      expect((await users.findOneByOrFail({ id: second.id })).phone).toBe(phone);
      expect(await users.findOneBy({ phone: accountPhoneWhere(phone) })).toBeNull();
      expect(await users.findOneBy({ phone: accountPhoneWhere('0890000001') })).toBeNull();
      const sendOtp = jest.fn();
      const auth = Object.assign(Object.create(AuthService.prototype), { userRepository: users, otpService: { sendOtp } });
      expect(await auth.requestPinResetOtp({ phone })).toEqual({ message: expect.stringContaining('Si ce compte') });
      expect(sendOtp).not.toHaveBeenCalled();
      await expect(saveRegistrationWithPhone(users, fresh())).rejects.toBeDefined();
      expect(await users.count()).toBe(2);
      expect((await users.findOneByOrFail({ id: first.id })).phone).toBe('0890000001');
      await users.update(first.id, { firstName: 'Updated' });
      await users.update(first.id, { phone: '0890000001' });
      expect(await source.query('SELECT * FROM registration_test_history'))
        .toEqual([{ id: historyId, userId: first.id, amount: 50 }]);
    });

    it('reads an unambiguous legacy account without rewriting its phone', async () => {
      await migrate('down');
      const old = await users.save({ ...fresh(), phone: ' 089 000 0001 ' });
      await migrate('up');
      expect((await users.findOneByOrFail({ phone: accountPhoneWhere(phone) })).id).toBe(old.id);
      expect((await users.findOneByOrFail({ id: old.id })).phone).toBe(' 089 000 0001 ');
      const sendOtp = jest.fn().mockResolvedValue({ expiresInSeconds: 900 });
      const set = jest.fn();
      const auth = Object.assign(Object.create(AuthService.prototype), {
        userRepository: users, otpService: { sendOtp }, redisService: { set },
      });
      await auth.requestPinResetOtp({ phone });
      expect(sendOtp).toHaveBeenCalledWith(phone, 'pin_reset');
      expect(set).toHaveBeenCalledWith(`auth:pin-reset-otp:${old.id}`, 'pending', 900);
    });

    it('rolls back the migration without deleting accounts, then reinstalls it', async () => {
      const user = await users.save(fresh());
      await migrate('down');
      expect(await users.findOneByOrFail({ id: user.id })).toEqual(user);
      await migrate('up');
      expect((await users.findOneByOrFail({ phone: accountPhoneWhere(phone) })).id).toBe(user.id);
    });

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

    it('rolls back the account, released phone and dependent records on signup failure', async () => {
      const old = await previous({ status: UserStatus.INACTIVE, isActive: false });
      await expect(saveRegistrationWithPhone(users, fresh(), async (created, manager) => {
        await manager.query('INSERT INTO registration_test_history VALUES ($1,$2,50)', [randomUUID(), created.id]);
        throw new Error('vehicle or referral failed');
      })).rejects.toThrow('vehicle or referral failed');
      expect(await users.count()).toBe(1);
      expect(await users.findOneByOrFail({ id: old.id })).toEqual(old);
      expect(await source.query('SELECT * FROM registration_test_history')).toEqual([]);
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
