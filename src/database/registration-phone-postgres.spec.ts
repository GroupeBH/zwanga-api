import { execFileSync } from 'child_process';
import { postgresTestServerOptions } from '../../test/postgres-test-options';
import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DataSource, EntitySchema, Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { saveRegistrationWithPhone } from '../users/registration-phone.policy';
import { CanonicalPhoneIdentity1780000119000 } from './migrations/1780000119000-CanonicalPhoneIdentity';
import { accountPhoneWhere, authAccountPhoneWhere, canonicalAccountPhone } from '../users/phone-identity';
import { AuthService } from '../auth/auth.service';
import { UsersService } from '../users/users.service';

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
          password: { type: String, nullable: true, select: false },
          lastLoginAt: { type: Date, nullable: true },
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

    it('preserves and quarantines historical collisions between enabled owners', async () => {
      await migrate('down');
      const first = await users.save({ ...fresh(), phone: '0890000001', status: UserStatus.ACTIVE });
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

    function authFixture() {
      const sendOtp = jest.fn().mockResolvedValue({ expiresInSeconds: 900 });
      const verifyOtp = jest.fn().mockResolvedValue({ valid: true });
      const values = new Map<string, string>();
      const set = jest.fn(async (key: string, value: string) => { values.set(key, value); });
      const generateTokens = jest.fn().mockResolvedValue({ accessToken: 'test-access', refreshToken: 'test-refresh' });
      const auth = Object.assign(Object.create(AuthService.prototype), {
        userRepository: users, otpService: { sendOtp, verifyOtp },
        redisService: {
          set, get: jest.fn(async (key: string) => values.get(key)),
          consumeIfValueMatches: jest.fn(async (key: string, expected: string) => {
            if (values.get(key) !== expected) return false;
            values.delete(key);
            return true;
          }),
        },
        logger: { log: jest.fn(), warn: jest.fn() }, generateTokens,
      }) as AuthService;
      return { auth, sendOtp, verifyOtp, set, generateTokens };
    }

    async function legacyOwners(overrides: Partial<User>[]) {
      await migrate('down');
      const owners: User[] = [];
      try {
        for (const override of overrides) owners.push(await users.save({ ...fresh(), ...override }));
      } finally { await migrate('up'); }
      return owners;
    }

    it.each([
      { status: UserStatus.INACTIVE, isActive: true },
      { status: UserStatus.INACTIVE, isActive: false },
      { status: UserStatus.ACTIVE, isActive: false },
      { status: UserStatus.PENDING_KYC, isActive: false },
    ])('logs in the only enabled owner despite a deactivated alias %j', async state => {
      const [inactive, enabled] = await legacyOwners([
        { phone: '0890000001', ...state, password: await bcrypt.hash('1111', 4) },
        { phone, password: await bcrypt.hash('2222', 4) },
      ]);
      const historyId = randomUUID();
      await source.query('INSERT INTO registration_test_history VALUES ($1,$2,50)', [historyId, inactive.id]);
      const f = authFixture();
      for (const input of ['0890000001', phone, '243890000001']) {
        expect((await users.findOneByOrFail({ phone: authAccountPhoneWhere(input) })).id).toBe(enabled.id);
        await expect(f.auth.login({ phone: input, pin: '2222' })).resolves.toMatchObject({ accessToken: 'test-access' });
        await expect(f.auth.login({ phone: input, pin: '1111' })).rejects.toBeInstanceOf(UnauthorizedException);
      }
      expect(f.generateTokens).toHaveBeenCalledTimes(3);
      expect(f.generateTokens.mock.calls.every(([owner]) => owner.id === enabled.id)).toBe(true);
      expect((await users.findOneByOrFail({ id: inactive.id })).lastLoginAt).toBeNull();
      expect(await source.query('SELECT * FROM registration_test_history'))
        .toEqual([{ id: historyId, userId: inactive.id, amount: 50 }]);
      // Login never transfers the database reservation or enables a new signup.
      expect(await source.query('SELECT "userId" FROM user_phone_identities')).toEqual([{ userId: null }]);
      expect(await users.findOneBy({ phone: accountPhoneWhere(phone) })).toBeNull();
      await expect(saveRegistrationWithPhone(users, fresh())).rejects.toBeDefined();
      expect(await users.count()).toBe(2);
    });

    it('uses the same enabled owner for PIN-reset send/verify and phone verification', async () => {
      const [inactive, enabled] = await legacyOwners([
        { phone: '0890000001', isActive: false }, { phone },
      ]);
      const f = authFixture();
      await f.auth.requestPinResetOtp({ phone: '0890000001' });
      expect(f.sendOtp).toHaveBeenCalledWith(phone, 'pin_reset');
      expect(f.set).toHaveBeenCalledWith(`auth:pin-reset-otp:${enabled.id}`, 'pending', 900);
      const result = await f.auth.verifyPinResetOtp({ phone, otp: '123456' });
      expect(result.resetToken.startsWith(`${enabled.id}.`)).toBe(true);
      expect(f.verifyOtp).toHaveBeenCalledWith(phone, '123456', 'pin_reset');
      const service = Object.assign(Object.create(UsersService.prototype), {
        userRepository: users, otpService: { verifyOtp: f.verifyOtp },
      }) as UsersService;
      await service.verifyPhoneOtp({ phone: '0890000001', otp: '123456' });
      expect((await users.findOneByOrFail({ id: enabled.id })).isPhoneVerified).toBe(true);
      expect((await users.findOneByOrFail({ id: inactive.id })).isPhoneVerified).toBe(false);
    });

    it('selects the enabled local spelling, not a disabled canonical spelling', async () => {
      const [enabled] = await legacyOwners([
        { phone: '0890000001', password: await bcrypt.hash('2222', 4) },
        { phone, isActive: false },
        { phone: '243890000001', status: UserStatus.INACTIVE },
      ]);
      const f = authFixture();
      await f.auth.login({ phone, pin: '2222' });
      expect(f.generateTokens).toHaveBeenCalledWith(expect.objectContaining({ id: enabled.id, phone: '0890000001' }));
      expect((await users.findOneByOrFail({ id: enabled.id })).phone).toBe('0890000001');
    });

    it('allows the enabled admin without selecting the inactive alias', async () => {
      const [, enabled] = await legacyOwners([
        { phone: '0890000001', status: UserStatus.INACTIVE, role: UserRole.SUPER_ADMIN },
        { phone, role: UserRole.ADMIN, password: await bcrypt.hash('test-admin-password', 4) },
      ]);
      const f = authFixture();
      await expect(f.auth.adminLogin({ phone: '0890000001', password: 'test-admin-password' }))
        .resolves.toMatchObject({ accessToken: 'test-access' });
      expect(f.generateTokens).toHaveBeenCalledWith(expect.objectContaining({ id: enabled.id, role: UserRole.ADMIN }));
      // Self-service reset still cannot reset an administrator's password.
      await f.auth.requestPinResetOtp({ phone });
      expect(f.sendOtp).not.toHaveBeenCalled();
    });

    it('never grants an inactive admin role to the remaining passenger', async () => {
      await legacyOwners([
        { phone: '0890000001', isActive: false, role: UserRole.ADMIN },
        { phone, password: await bcrypt.hash('2222', 4) },
      ]);
      const f = authFixture();
      await expect(f.auth.adminLogin({ phone, pin: '2222' })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(f.generateTokens).not.toHaveBeenCalled();
    });

    it('still blocks two enabled owners even when a third alias is deactivated', async () => {
      await legacyOwners([
        { phone: '0890000001', isActive: false },
        { phone, password: await bcrypt.hash('2222', 4) },
        { phone: '243890000001', role: UserRole.ADMIN, password: await bcrypt.hash('2222', 4) },
      ]);
      const f = authFixture();
      expect(await users.findOneBy({ phone: authAccountPhoneWhere(phone) })).toBeNull();
      await expect(f.auth.login({ phone, pin: '2222' })).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(f.auth.adminLogin({ phone, pin: '2222' })).rejects.toBeInstanceOf(UnauthorizedException);
      await f.auth.requestPinResetOtp({ phone });
      expect(f.sendOtp).not.toHaveBeenCalled();
      expect(f.generateTokens).not.toHaveBeenCalled();
    });

    it('never authenticates or sends reset SMS when every owner is deactivated', async () => {
      await legacyOwners([
        { phone: '0890000001', isActive: false }, { phone, status: UserStatus.INACTIVE },
      ]);
      const f = authFixture();
      expect(await users.findOneBy({ phone: authAccountPhoneWhere(phone) })).toBeNull();
      await expect(f.auth.login({ phone, pin: '2222' })).rejects.toBeInstanceOf(UnauthorizedException);
      await f.auth.requestPinResetOtp({ phone });
      expect(f.sendOtp).not.toHaveBeenCalled();
      expect(f.generateTokens).not.toHaveBeenCalled();
    });

    it('does not silently ignore a suspended owner or bypass its login restriction', async () => {
      const [suspended, enabled] = await legacyOwners([
        { phone: '0890000001', status: UserStatus.SUSPENDED }, { phone },
      ]);
      expect(await users.findOneBy({ phone: authAccountPhoneWhere(phone) })).toBeNull();
      await users.update(enabled.id, { isActive: false });
      expect((await users.findOneByOrFail({ phone: authAccountPhoneWhere(phone) })).id).toBe(suspended.id);
      const f = authFixture();
      await expect(f.auth.login({ phone, pin: '2222' })).rejects.toThrow('Compte suspendu');
      await f.auth.requestPinResetOtp({ phone });
      expect(f.sendOtp).not.toHaveBeenCalled();
      expect(f.generateTokens).not.toHaveBeenCalled();
    });

    it('fails closed again when a historical duplicate is reactivated', async () => {
      const [inactive, enabled] = await legacyOwners([
        { phone: '0890000001', isActive: false }, { phone },
      ]);
      expect((await users.findOneByOrFail({ phone: authAccountPhoneWhere(phone) })).id).toBe(enabled.id);
      await users.update(inactive.id, { isActive: true });
      expect(await users.findOneBy({ phone: authAccountPhoneWhere(phone) })).toBeNull();
      const f = authFixture();
      await expect(f.auth.login({ phone, pin: '2222' })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(f.generateTokens).not.toHaveBeenCalled();
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
      const before = await users.findOneByOrFail({ id: user.id });
      await migrate('down');
      try { expect(await users.findOneByOrFail({ id: user.id })).toEqual(before); }
      finally { await migrate('up'); }
      expect((await users.findOneByOrFail({ phone: accountPhoneWhere(phone) })).id).toBe(user.id);
    });

    async function previous(state: { status: UserStatus; isActive: boolean }) {
      const saved = await users.save(
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
      return users.findOneByOrFail({ id: saved.id });
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
