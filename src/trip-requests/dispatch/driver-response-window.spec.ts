import { DriverResponse75Seconds1780000107000 } from '../../database/migrations/1780000107000-DriverResponse75Seconds';
import { DriverResponse40Seconds1780000108000 } from '../../database/migrations/1780000108000-DriverResponse40Seconds';
import { DriverDispatchService } from './dispatch.service';
import { REQUEST_RESPONSE_MS } from './sequential-policy';

describe('40-second driver response policy', () => {
  it('announces the same window as allocation, without using the legacy override', () => {
    const service = Object.assign(Object.create(DriverDispatchService.prototype), {
      sequential: {}, config: { get: () => '90' },
    });
    expect(REQUEST_RESPONSE_MS).toBe(40_000);
    expect(service.responseSeconds).toBe(40);
  });
  it.each([
    [new DriverResponse75Seconds1780000107000(), 75, 40],
    [new DriverResponse40Seconds1780000108000(), 40, 75],
  ] as const)('changes only the future INSERT cap in a bounded reversible migration %s', async (migration, up, down) => {
    const query = jest.fn();
    await expect(migration.up({ query, isTransactionActive: false } as any)).rejects.toThrow('transaction');
    expect(query).not.toHaveBeenCalled();
    await migration.up({ query, isTransactionActive: true } as any);
    expect(query.mock.calls[0][0]).toContain("lock_timeout = '5s'");
    expect(query.mock.calls[2][0]).toContain(`interval '${up} seconds'`);
    expect(query.mock.calls[2][0]).toContain('LEAST(NEW."expiresAt"');
    expect(query.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(/UPDATE\s+trip_request_dispatch_offers/i);
    await migration.down({ query, isTransactionActive: true } as any);
    expect(query.mock.calls[5][0]).toContain(`interval '${down} seconds'`);
  });
});
