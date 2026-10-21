import { QueryRunner } from 'typeorm';
import { ReferralAttributionAudit1780000082000 } from './migrations/1780000082000-ReferralAttributionAudit';

describe('non-financial referral attribution audit migration', () => {
  const migration = new ReferralAttributionAudit1780000082000();
  it('adds nullable audit fields without altering financial history', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await migration.up({ isTransactionActive: true, query } as unknown as QueryRunner);
    const sql = query.mock.calls.map(([value]) => value).join('\n');
    expect(sql).toContain('ADD COLUMN "attributionAdminId" uuid');
    expect(sql).toContain('ADD COLUMN "attributionAdminReason" varchar(300)');
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b|referral_accounts|referral_ledger_entries/);
  });
  it.each(['up', 'down'] as const)('requires a transaction for %s', async direction => {
    const query = jest.fn();
    await expect(migration[direction]({ isTransactionActive: false, query } as unknown as QueryRunner))
      .rejects.toThrow('transaction');
    expect(query).not.toHaveBeenCalled();
  });
  it('refuses to erase an admin audit on rollback', async () => {
    const query = jest.fn().mockResolvedValue([{ used: true }]);
    await expect(migration.down({ isTransactionActive: true, query } as unknown as QueryRunner))
      .rejects.toThrow('must be preserved');
    expect(query.mock.calls.map(([value]) => value).join('\n')).not.toContain('DROP COLUMN');
  });
  it('reverts unused fields under the same lock as the audit check', async () => {
    const query = jest.fn().mockResolvedValue([{ used: false }]);
    await migration.down({ isTransactionActive: true, query } as unknown as QueryRunner);
    expect(query.mock.calls[2][0]).toContain('ACCESS EXCLUSIVE');
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('DROP COLUMN "attributionAdminId"'));
  });
});
