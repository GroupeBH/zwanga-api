import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { ReceiptResponseWindow1780000110000 } from './migrations/1780000110000-ReceiptResponseWindow';
import { startReceivedResponseWindow } from '../trip-requests/dispatch/receipt-response-window';
import { WALLET_BALANCE_MISMATCH_SQL } from '../wallet/wallet-integrity';
import { pauseUnavailableRecurring } from '../trips/pause-unavailable-recurring';
import { enqueueTransactionalNotification } from '../notifications/transactional-notification';

jest.mock('../notifications/transactional-notification', () => ({ enqueueTransactionalNotification: jest.fn() }));

const bin = process.env.AUDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('coherence regressions on disposable PostgreSQL', () => {
  let fixture: IsolatedPostgres, db: DataSource;
  const migration = new ReceiptResponseWindow1780000110000();
  const user = randomUUID(), request = randomUUID(), offer = randomUUID(), notification = randomUUID();
  const change = (direction: 'up' | 'down') => db.transaction(m => migration[direction](m.queryRunner!));
  const receive = (who = user, id = notification) => db.transaction(m => startReceivedResponseWindow(m, who, id));
  beforeAll(async () => {
    fixture = new IsolatedPostgres(bin!); db = await fixture.start();
    await db.query(`CREATE TABLE trip_requests (id uuid PRIMARY KEY, status text DEFAULT 'pending',
      "selectedDriverId" uuid, "tripId" uuid, "targetDriverPriorityUntil" timestamptz, "departureDateMax" timestamptz);
      CREATE TABLE trip_request_dispatch_offers (id uuid PRIMARY KEY, "requestId" uuid, "driverId" uuid,
        status text DEFAULT 'pending', phase text DEFAULT 'driver', sequential boolean DEFAULT true, "expiresAt" timestamptz);
      CREATE TABLE notifications (id uuid PRIMARY KEY, "userId" varchar, "isActive" boolean DEFAULT true, "eventKey" text, data jsonb);
      CREATE TABLE wallet_accounts (id uuid PRIMARY KEY, balance numeric(12,2));
      CREATE TABLE wallet_ledger_entries (id uuid PRIMARY KEY, "accountId" uuid, amount numeric(12,2),
        "balanceAfter" numeric(12,2), "createdAt" timestamptz DEFAULT now());
      CREATE TABLE vehicles (id uuid PRIMARY KEY, "ownerId" varchar, "isActive" boolean);
      CREATE TABLE recurring_trip_templates (id uuid PRIMARY KEY, "driverId" varchar, "vehicleId" varchar,
        status text DEFAULT 'active', "updatedAt" timestamp);`);
    await change('up');
  }, 90000);
  afterAll(async () => { await fixture?.stop(); });
  beforeEach(async () => {
    await db.query('TRUNCATE trip_requests, trip_request_dispatch_offers, notifications, wallet_accounts, wallet_ledger_entries, vehicles, recurring_trip_templates');
    jest.mocked(enqueueTransactionalNotification).mockReset().mockImplementation(async (tx, value) => {
      await tx.query('INSERT INTO notifications(id,"userId","eventKey",data) VALUES($1,$2,$3,$4)',
        [randomUUID(), value.userId, value.eventKey, value.data]);
    });
    await db.query(`INSERT INTO trip_requests (id,"departureDateMax") VALUES ($1, now()+interval '1 hour')`, [request]);
    // Delivery has already consumed 25 of its initial 40 seconds.
    await db.query(`INSERT INTO trip_request_dispatch_offers (id,"requestId","driverId","expiresAt","deliveryDeadlineAt")
      VALUES ($1,$2,$3,now()+interval '15 seconds',now()+interval '15 seconds')`, [offer, request, user]);
    await db.query(`INSERT INTO notifications (id,"userId","eventKey",data) VALUES ($1,$2,$3,$4)`,
      [notification, user, 'sequential-offer:' + offer, { type: 'driver_dispatch_offer', tripRequestId: request, offerId: offer }]);
  });
  it('grants 40 seconds after first receipt, not 15; concurrent duplicates never renew it', async () => {
    const started = Date.now();
    const [one, two] = await Promise.all([receive(), receive()]);
    expect(Date.parse(one!.expiresAt) - started).toBeGreaterThanOrEqual(39_000);
    expect(one!.expiresAt).toBe(two!.expiresAt);
    expect((await receive())!.expiresAt).toBe(one!.expiresAt);
  });
  it('caps response at the passenger deadline', async () => {
    await db.query(`UPDATE trip_requests SET "departureDateMax"=now()+interval '10 seconds'`);
    expect(Date.parse((await receive())!.expiresAt) - Date.now()).toBeLessThanOrEqual(10_000);
  });
  it.each(['expired', 'declined', 'accepted', 'cancelled'])('does not revive a %s invitation', async status => {
    await db.query('UPDATE trip_request_dispatch_offers SET status=$1', [status]);
    expect(await receive()).toBeUndefined();
  });
  it('rejects a foreign recipient, inactive notification, forged offer and elapsed delivery window', async () => {
    expect(await receive(randomUUID())).toBeUndefined();
    await db.query('UPDATE notifications SET "isActive"=false');
    expect(await receive()).toBeUndefined();
    await db.query('UPDATE notifications SET "isActive"=true, "eventKey"=$1', ['sequential-offer:' + randomUUID()]);
    expect(await receive()).toBeUndefined();
    await db.query('UPDATE notifications SET "eventKey"=$1', ['sequential-offer:' + offer]);
    await db.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second'`);
    expect(await receive()).toBeUndefined();
  });
  it('keeps pre-upgrade invitations and manually targeted priorities unchanged', async () => {
    await db.query('UPDATE trip_request_dispatch_offers SET "deliveryDeadlineAt"=NULL');
    expect(await receive()).toBeUndefined();
    await db.query('UPDATE trip_request_dispatch_offers SET "deliveryDeadlineAt"="expiresAt"');
    await db.query(`UPDATE trip_requests SET "targetDriverPriorityUntil"=now()+interval '3 minutes'`);
    expect(await receive()).toBeUndefined();
  });
  it('has a reversible additive migration without rewriting active deadlines', async () => {
    const before = await db.query('SELECT "expiresAt" FROM trip_request_dispatch_offers');
    await change('down'); await change('up');
    expect(await db.query('SELECT "expiresAt" FROM trip_request_dispatch_offers')).toEqual(before);
    expect(await receive()).toBeUndefined();
  });
  it('does not mistake simultaneous UUID-ordered credits for a corrupt wallet, but catches real mismatches', async () => {
    const account = randomUUID();
    await db.query('INSERT INTO wallet_accounts VALUES ($1, 150)', [account]);
    await db.query(`INSERT INTO wallet_ledger_entries (id,"accountId",amount,"balanceAfter") VALUES
      ('ffffffff-ffff-4fff-afff-ffffffffffff',$1,100,100),
      ('00000000-0000-4000-a000-000000000000',$1,50,150)`, [account]);
    expect((await db.query(WALLET_BALANCE_MISMATCH_SQL))[0].count).toBe(0);
    await db.query('UPDATE wallet_accounts SET balance=140');
    expect((await db.query(WALLET_BALANCE_MISMATCH_SQL))[0].count).toBe(1);
    expect((await db.query('SELECT balance FROM wallet_accounts'))[0].balance).toBe('140.00');
    await db.query(`INSERT INTO wallet_ledger_entries(id,"accountId",amount,"balanceAfter") VALUES ($1,$2,-10,140)`, [randomUUID(), account]);
    expect((await db.query(WALLET_BALANCE_MISMATCH_SQL))[0].count).toBe(0);
  });
  it('detects an unexplained nonzero balance without entries but accepts a new zero account', async () => {
    await db.query('INSERT INTO wallet_accounts VALUES ($1,0),($2,10)', [randomUUID(), randomUUID()]);
    expect((await db.query(WALLET_BALANCE_MISMATCH_SQL))[0].count).toBe(1);
  });
  async function recurringFixture() {
    const vehicleId = randomUUID(), id = randomUUID();
    await db.query('INSERT INTO vehicles VALUES($1,$2,false)', [vehicleId, user]);
    await db.query(`INSERT INTO recurring_trip_templates(id,"driverId","vehicleId","updatedAt")
      VALUES($1,$2,$3,'2026-11-02 12:00:00.123456')`, [id, user, vehicleId]);
    return (await db.query('SELECT * FROM recurring_trip_templates WHERE id=$1', [id]))[0];
  }
  it('pauses an inactive recurring vehicle once despite PostgreSQL microsecond timestamps', async () => {
    const template = await recurringFixture();
    expect(await pauseUnavailableRecurring(db.manager, template)).toBe(true);
    expect(await pauseUnavailableRecurring(db.manager, template)).toBe(false);
    expect((await db.query('SELECT status FROM recurring_trip_templates'))[0].status).toBe('paused');
    expect((await db.query(`SELECT count(*)::int AS count FROM notifications WHERE "eventKey" LIKE 'recurring-unavailable:%'`))[0].count).toBe(1);
  });
  it('does not pause a repaired vehicle or overwrite a later template revision', async () => {
    const template = await recurringFixture();
    await db.query('UPDATE vehicles SET "isActive"=true');
    expect(await pauseUnavailableRecurring(db.manager, template)).toBe(false);
    await db.query('UPDATE vehicles SET "isActive"=false');
    await db.query(`UPDATE recurring_trip_templates SET "updatedAt"="updatedAt"+interval '1 second'`);
    expect(await pauseUnavailableRecurring(db.manager, template)).toBe(false);
    expect(enqueueTransactionalNotification).not.toHaveBeenCalled();
  });
  it('rolls the pause back when the transactional notification cannot be saved', async () => {
    const template = await recurringFixture();
    jest.mocked(enqueueTransactionalNotification).mockRejectedValueOnce(new Error('outbox write failed'));
    await expect(pauseUnavailableRecurring(db.manager, template)).rejects.toThrow('outbox write failed');
    expect((await db.query('SELECT status FROM recurring_trip_templates'))[0].status).toBe('active');
  });
});
