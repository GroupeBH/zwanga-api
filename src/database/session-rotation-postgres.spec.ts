import { randomUUID } from 'crypto';
import { DataSource, EntitySchema } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { AuthService } from '../auth/auth.service';
import { User } from '../users/entities/user.entity';
import { tokenFingerprint } from '../auth/token-fingerprint';

const bin = process.env.AUDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('session rotation on isolated PostgreSQL', () => {
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource;
  beforeAll(async () => {
    db = await cluster.start();
    await db.destroy();
    db.setOptions({ entities: [new EntitySchema({ name: 'User', target: User, tableName: 'users', columns: {
      id: { type: 'uuid', primary: true }, phone: { type: 'text' }, role: { type: 'text' },
      status: { type: 'text' }, isActive: { type: 'boolean' },
      refreshToken: { type: 'text', nullable: true }, accessToken: { type: 'text', nullable: true },
      fcmToken: { type: 'text', nullable: true },
    } })] });
    await db.initialize();
    await db.query(`CREATE TABLE users (id uuid PRIMARY KEY, phone text, role text, status text,
      "isActive" boolean, "refreshToken" text, "accessToken" text, "fcmToken" text)`);
  }, 120000);
  afterAll(() => cluster.stop(), 40000);

  async function setup() {
    const id = randomUUID();
    await db.query(`INSERT INTO users VALUES ($1,'synthetic','passenger','active',true,$2,'old-access',NULL)`,
      [id, tokenFingerprint('old-refresh')]);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const gate = new Promise<void>(done => { release = done; });
    let count = 0;
    const service = Object.assign(Object.create(AuthService.prototype), {
      logger: { log: jest.fn() }, configService: { get: () => undefined }, userRepository: db.getRepository(User),
      jwtService: { verifyAsync: async () => ({ sub: id }), signAsync: async () => {
        entered(); await gate; return `synthetic-${id}-${++count}`;
      } },
    });
    return { id, service, started, release };
  }

  it('does not restore a session after logout commits', async () => {
    const test = await setup();
    const rejected = expect(test.service.refreshToken({ refreshToken: 'old-refresh' })).rejects.toMatchObject({ status: 401 });
    await test.started;
    await test.service.logout(test.id);
    test.release();
    await rejected;
    expect(await db.query('SELECT "refreshToken", "accessToken" FROM users WHERE id=$1', [test.id]))
      .toEqual([{ refreshToken: null, accessToken: null }]);
  });

  it('rechecks the refresh predicate after a concurrent PIN-reset transaction commits', async () => {
    const test = await setup();
    const rejected = expect(test.service.refreshToken({ refreshToken: 'old-refresh' })).rejects.toMatchObject({ status: 401 });
    await test.started;
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query('UPDATE users SET "refreshToken"=NULL,"accessToken"=NULL WHERE id=$1', [test.id]);
      test.release();
      await runner.commitTransaction();
      await rejected;
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('accepts exactly one of two overlapping refreshes', async () => {
    const test = await setup();
    const results = Promise.allSettled([test.service.refreshToken({ refreshToken: 'old-refresh' }),
      test.service.refreshToken({ refreshToken: 'old-refresh' })]);
    await test.started;
    test.release();
    const settled = await results;
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1);
  });
});
