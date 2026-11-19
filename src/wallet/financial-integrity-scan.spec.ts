import { scanFinancialIntegrity } from './financial-integrity-scan';

describe('bounded complete financial audit', () => {
  it('visits older pages with an indexed cursor and returns complete counts', async () => {
    const sql = jest.fn().mockResolvedValueOnce({ inspected: 2, anomalies: 1, cursor: 'a' })
      .mockResolvedValueOnce({ inspected: 1, anomalies: 1, cursor: 'b' })
      .mockResolvedValueOnce({ inspected: 2, anomalies: 2, cursor: 'c' })
      .mockResolvedValueOnce({ inspected: 0, anomalies: 0, cursor: null });
    const query = jest.fn(async (text, params) => text.startsWith('SELECT set_config') ? [] : [await sql(text, params)]);
    const db = { transaction: jest.fn(fn => fn({ query })) };
    await expect(scanFinancialIntegrity(db as any, jest.fn(), 2)).resolves.toEqual({ unsafeAnomalies: 2, walletBalanceMismatches: 2 });
    expect(sql.mock.calls.map(call => call[1][0])).toEqual([null, 'a', null, 'c']);
    expect(query.mock.calls.filter(call => call[0].includes("set_config('statement_timeout'")).length).toBe(4);
  });
  it('does not hide a failed page or lost lease as a clean audit', async () => {
    const db = { transaction: jest.fn().mockRejectedValue(new Error('statement timeout')) };
    await expect(scanFinancialIntegrity(db as any, jest.fn())).rejects.toThrow('statement timeout');
    db.transaction.mockClear();
    await expect(scanFinancialIntegrity(db as any, () => { throw new Error('lost lease'); })).rejects.toThrow('lost lease');
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
