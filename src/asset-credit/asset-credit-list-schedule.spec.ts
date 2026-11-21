import { AssetCreditService } from './asset-credit.service';
import { DataSource } from 'typeorm';

describe('Credit dashboard schedules', () => {
  it('returns every contract schedule in the existing grouped read without changing amounts', async () => {
    const row = { id: 'synthetic', status: 'active', principalMinor: '100000', paidMinor: '20000',
      costDisclosureVersion: 'asset-credit-cost-v1', installmentCount: 2, installmentPeriod: 'month',
      activatedAt: '2026-01-31T12:00:00.000Z' };
    const db = { query: jest.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([{ total: 500 }]) };
    const result = await new AssetCreditService(db as unknown as DataSource).list('synthetic-driver');
    expect(result.items[0]).toMatchObject({ ...row, nextInstallment:
      { ordinal: 1, dueAt: '2026-02-28T12:00:00.000Z', remainingMinor: 30000 } });
    expect(result.items[0]).not.toHaveProperty('installments');
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(row).not.toHaveProperty('installments');
  });
});
