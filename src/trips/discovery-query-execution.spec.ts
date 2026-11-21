import { executeDiscoveryRead } from './discovery-query-execution';
import { QueryRunner, SelectQueryBuilder } from 'typeorm';
import { Trip } from './entities/trip.entity';

describe('Discovery timing instrumentation', () => {
  const fixture = () => {
    const data: { entities: Trip[]; raw: unknown[] } = {
      entities: [],
      raw: [],
    };
    const runner = {
      connect: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
      release: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
      query: jest
        .fn<Promise<typeof data>, [string, unknown[]?, boolean?]>()
        .mockResolvedValue(data),
    };
    const originalQuery = runner.query;
    const query = {
      queryRunner: undefined as QueryRunner | undefined,
      connection: { createQueryRunner: jest.fn().mockReturnValue(runner) },
      setQueryRunner: jest.fn(),
      getRawAndEntities: jest.fn(() =>
        runner.query('SELECT internal', ['private'], true),
      ),
    };
    const read = () =>
      executeDiscoveryRead(query as unknown as SelectQueryBuilder<Trip>);
    return { query, runner, originalQuery, data, read };
  };

  it('measures acquisition/read and preserves structured TypeORM results without retaining parameters', async () => {
    const { query, runner, originalQuery, data, read } = fixture();
    const result = await read();
    expect(result.entities).toBe(data.entities);
    expect(result.raw).toBe(data.raw);
    expect(Object.keys(result.timings).sort()).toEqual([
      'databaseRoundTripMs',
      'ormMs',
      'poolWaitMs',
      'queryCount',
    ]);
    expect(result.timings.queryCount).toBe(1);
    for (const value of Object.values(result.timings))
      expect(value).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result.timings)).not.toContain('private');
    expect(originalQuery).toHaveBeenCalledWith(
      'SELECT internal',
      ['private'],
      true,
    );
    expect(runner.query).toBe(originalQuery);
    expect(runner.release).toHaveBeenCalledTimes(1);
    expect(query.queryRunner).toBeUndefined();
  });

  it.each(['connect', 'query', 'hydrate'])(
    'releases its runner after a %s failure',
    async (phase) => {
      const { query, runner, originalQuery, read } = fixture();
      const error = new Error('test failure');
      if (phase === 'connect') runner.connect.mockRejectedValue(error);
      else if (phase === 'query') originalQuery.mockRejectedValue(error);
      else query.getRawAndEntities.mockRejectedValue(error);
      await expect(read()).rejects.toBe(error);
      expect(runner.query).toBe(originalQuery);
      expect(runner.release).toHaveBeenCalledTimes(1);
    },
  );

  it('does not replace, reconnect or release a caller-owned transactional runner', async () => {
    const { query, runner, originalQuery, read } = fixture();
    query.queryRunner = runner as unknown as QueryRunner;
    const result = await read();
    expect(result.timings).toEqual({ poolWaitMs: 0 });
    expect(query.connection.createQueryRunner).not.toHaveBeenCalled();
    expect(query.setQueryRunner).not.toHaveBeenCalled();
    expect(runner.query).toBe(originalQuery);
    expect(runner.connect).not.toHaveBeenCalled();
    expect(runner.release).not.toHaveBeenCalled();
  });
});
