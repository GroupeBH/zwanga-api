import { WalletService } from './wallet.service';
import { WalletAccount } from './entities/wallet-account.entity';
import { WalletLedgerEntry } from './entities/wallet-ledger-entry.entity';
import { walletTransferId } from './transfer-idempotency';

const key = '00000000-0000-4000-8000-000000000001';
function fixture() {
  const accounts = new Map(['sender', 'recipient', 'other'].map(userId => [userId,
    { id: `wallet-${userId}`, userId, balance: userId === 'sender' ? 100 : 0, withdrawableBalance: 80, currency: 'PTS' }]));
  accounts.get('recipient')!.withdrawableBalance = 0;
  accounts.get('other')!.withdrawableBalance = 0;
  const ledger: any[] = [], locks: string[] = [];
  const manager = {
    findOne: jest.fn(async (entity, { where, lock }) => {
      if (entity === WalletAccount) { expect(lock.mode).toBe('pessimistic_write'); locks.push(where.userId); return accounts.get(where.userId); }
      if (entity === WalletLedgerEntry) return ledger.find(entry => Object.entries(where).every(([k, v]) => entry[k] === v)) ?? null;
      return null;
    }),
    create: jest.fn((_entity, value) => value),
    save: jest.fn(async value => { if (value.accountId) { value.id = `entry-${ledger.length}`; ledger.push(value); } return value; }),
  };
  const service = new WalletService({} as any, {} as any, {} as any,
    { transaction: async action => action(manager) } as any, {} as any, {} as any);
  jest.spyOn(service as any, 'resolveTransferRecipient').mockImplementation(async (dto: any) => ({
    id: dto.recipientUserId ?? 'recipient', firstName: 'Test', lastName: 'Account', phone: null, email: null,
  }));
  return { service, accounts, ledger, locks, manager };
}
describe('wallet transfer idempotency (repository simulation, not a PostgreSQL concurrency test)', () => {
  it('scopes deterministic UUIDs to the authenticated sender and key, case-insensitively', () => {
    const first = walletTransferId('sender', key);
    expect(walletTransferId('sender', key.toUpperCase())).toBe(first);
    expect(walletTransferId('other', key)).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('reuses the two ledger entries and never debits again, even when the current balance is insufficient for a second transfer', async () => {
    const f = fixture(), dto = { amount: 70, recipientUserId: 'recipient', idempotencyKey: key, note: 'test' };
    const first = await f.service.transferPoints('sender', dto);
    const replay = await f.service.transferPoints('sender', dto);
    expect(replay.transferId).toBe(first.transferId);
    expect(replay.senderEntry.id).toBe(first.senderEntry.id);
    expect(f.accounts.get('sender')!.balance).toBe(30);
    expect(f.accounts.get('recipient')!.balance).toBe(70);
    expect(f.ledger).toHaveLength(2);
    expect(f.locks).toEqual(['recipient', 'sender', 'recipient', 'sender']);
  });
  it.each([{ amount: 6 }, { recipientUserId: 'other' }, { note: 'different' }])('rejects changed payload for the same key: %j', async change => {
    const f = fixture(), dto = { amount: 5, recipientUserId: 'recipient', idempotencyKey: key, note: 'test' };
    await f.service.transferPoints('sender', dto);
    await expect(f.service.transferPoints('sender', { ...dto, ...change })).rejects.toThrow('autre transfert');
    expect(f.ledger).toHaveLength(2); expect(f.accounts.get('sender')!.balance).toBe(95);
  });
  it('keeps legacy clients without a key compatible and permits intentional distinct transfers', async () => {
    const f = fixture();
    const first = await f.service.transferPoints('sender', { amount: 5, recipientUserId: 'recipient' });
    const second = await f.service.transferPoints('sender', { amount: 5, recipientUserId: 'recipient' });
    expect(first.transferId).not.toBe(second.transferId);
    expect(f.accounts.get('sender')!.balance).toBe(90);
  });
});
