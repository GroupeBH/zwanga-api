import { BadRequestException } from '@nestjs/common';
import { loadWalletLedgerPage } from './wallet-ledger-page';
import { WalletAccountType } from './entities/wallet-account.entity';

const id = '00000000-0000-4000-8000-000000000001';
const at = '2026-09-25T08:00:00.123456';
function fixture() {
  const query = {
    where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), clone: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(), getCount: jest.fn().mockResolvedValue(300),
    getRawAndEntities: jest.fn().mockResolvedValue({ entities: [{ id }, { id }, { id }],
      raw: [{ cursorTime: at }, { cursorTime: at }, { cursorTime: at }] }),
  };
  return { query, repository: { createQueryBuilder: jest.fn().mockReturnValue(query) } as any };
}
describe('wallet ledger pagination', () => {
  it('scopes all pages to the authenticated user and points account, with stable timestamp/id ordering', async () => {
    const f = fixture();
    const result = await loadWalletLedgerPage(f.repository, 'authenticated-account', { limit: 2 });
    expect(f.query.where).toHaveBeenCalledWith('entry.userId = :userId', { userId: 'authenticated-account' });
    expect(f.query.andWhere).toHaveBeenCalledWith('entry.accountType = :accountType', { accountType: WalletAccountType.POINTS });
    expect(f.query.take).toHaveBeenCalledWith(3);
    expect(result.data).toHaveLength(2); expect(result.total).toBe(300);
    expect(JSON.parse(Buffer.from(result.nextCursor!, 'base64url').toString())).toEqual({ at, id });
    await loadWalletLedgerPage(f.repository, 'authenticated-account', { before: result.nextCursor! });
    expect(f.query.andWhere).toHaveBeenCalledWith('(entry.createdAt, entry.id) < (:at::timestamp, :id::uuid)', { at, id });
  });
  it('caps the page size and rejects malformed cursors without a full ledger fallback', async () => {
    const f = fixture();
    await loadWalletLedgerPage(f.repository, 'authenticated-account', { limit: 999 });
    expect(f.query.take).toHaveBeenCalledWith(51);
    f.query.getRawAndEntities.mockClear();
    await expect(loadWalletLedgerPage(f.repository, 'authenticated-account', { before: 'invalid' })).rejects.toBeInstanceOf(BadRequestException);
    expect(f.query.getRawAndEntities).not.toHaveBeenCalled();
  });
});
