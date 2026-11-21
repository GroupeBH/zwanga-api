import { SpanStatusCode, trace } from '@opentelemetry/api';
import { QueryRunner, SelectQueryBuilder } from 'typeorm';
import { Trip } from './entities/trip.entity';

export interface DiscoveryReadTimings {
  poolWaitMs: number;
  databaseRoundTripMs?: number;
  ormMs?: number;
  queryCount?: number;
}

/** Timings only: never records SQL, parameters, coordinates or result data. */
export async function executeDiscoveryRead(query: SelectQueryBuilder<Trip>) {
  return trace
    .getTracer('zwanga.trips')
    .startActiveSpan('trips.discovery.select', async (span) => {
      // TypeORM exposes a setter but no getter/resetter for its optional runner.
      // Keep this narrow adapter here; integration tests cover both ownership modes.
      const binding = query as unknown as { queryRunner?: QueryRunner };
      const ownsRunner = !binding.queryRunner;
      const runner =
        binding.queryRunner ?? query.connection.createQueryRunner('slave');
      // Preserve method identity for restoration; all calls use the bound copy.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const originalQuery = runner.query;
      const executeQuery = originalQuery.bind(runner) as (
        sql: string,
        parameters?: unknown[],
        structured?: boolean,
      ) => Promise<unknown>;
      const timings: DiscoveryReadTimings = { poolWaitMs: 0 };
      try {
        if (ownsRunner) {
          const started = performance.now();
          await runner.connect();
          timings.poolWaitMs = performance.now() - started;
          timings.databaseRoundTripMs = 0;
          timings.queryCount = 0;
          // Only wrap this privately owned runner; never mutate a caller's
          // transaction/connection. Preserve TypeORM's structured result flag.
          runner.query = (async (
            sql: string,
            parameters?: unknown[],
            structured?: boolean,
          ) => {
            const started = performance.now();
            timings.queryCount!++;
            try {
              return await executeQuery(sql, parameters, structured);
            } finally {
              timings.databaseRoundTripMs! += performance.now() - started;
            }
          }) as QueryRunner['query'];
          query.setQueryRunner(runner);
        }
        const readStarted = performance.now();
        const result = await query.getRawAndEntities();
        if (ownsRunner)
          timings.ormMs = Math.max(
            0,
            performance.now() - readStarted - timings.databaseRoundTripMs!,
          );
        span.setAttributes({
          'discovery.pool_wait_ms': timings.poolWaitMs,
          ...(ownsRunner
            ? {
                'discovery.database_round_trip_ms':
                  timings.databaseRoundTripMs!,
                'discovery.orm_ms': timings.ormMs!,
                'discovery.query_count': timings.queryCount!,
              }
            : {}),
        });
        return { ...result, timings };
      } catch (error) {
        // Exception messages may contain bound parameters; deliberately omit them.
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'discovery_read_failed',
        });
        throw error;
      } finally {
        try {
          if (ownsRunner) {
            runner.query = originalQuery;
            binding.queryRunner = undefined;
            await runner.release();
          }
        } finally {
          span.end();
        }
      }
    });
}
