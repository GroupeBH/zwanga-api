import type { QueryRunner } from 'typeorm';
import { PerformanceWorkQueues1780000135000 } from './migrations/1780000135000-PerformanceWorkQueues';

describe('performance work queue migration budgets', () => {
  for (const direction of ['up', 'down'] as const) {
    it(`${direction} sets local lock and statement budgets in the DDL batch`, async () => {
      const query = jest
        .fn<Promise<unknown[]>, [string]>()
        .mockResolvedValue([]);
      await new PerformanceWorkQueues1780000135000()[direction]({
        query,
      } as unknown as QueryRunner);
      expect(query).toHaveBeenCalledTimes(1);
      const sql: string = query.mock.calls[0][0];
      expect(sql).toMatch(
        /^SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';/,
      );
      if (direction === 'down') {
        expect(sql.indexOf('Drain ride progress jobs')).toBeLessThan(
          sql.indexOf('DROP TABLE'),
        );
        expect(sql.indexOf('Stop maintenance workers')).toBeLessThan(
          sql.indexOf('DROP TABLE'),
        );
      }
    });
  }

  it('propagates lock/DDL failures to stop the deployment', async () => {
    const query = jest
      .fn<Promise<unknown[]>, [string]>()
      .mockRejectedValue(new Error('lock timeout'));
    await expect(
      new PerformanceWorkQueues1780000135000().up({
        query,
      } as unknown as QueryRunner),
    ).rejects.toThrow('lock timeout');
  });
});
