import type { DataSource, EntityManager } from 'typeorm';
import type { TripRequest } from '../src/trip-requests/entities/trip-request.entity';
import { sequentialCandidates } from '../src/trip-requests/dispatch/sequential-candidates';

/** Disposable fixtures only. Never prints bind values, account IDs or coordinates. */
export async function profileSequentialDiscovery(db: DataSource, request: TripRequest, label: string) {
  let sql = '', parameters: unknown[] = [];
  await sequentialCandidates({ query: async (query: string, args: unknown[]) => {
    sql = query; parameters = args; return [];
  } } as unknown as EntityManager, request);
  const [row] = await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, parameters);
  const plan = row['QUERY PLAN'][0];
  const nodes: Record<string, unknown>[] = [];
  const visit = (node: Record<string, any>) => {
    nodes.push({ type: node['Node Type'], relation: node['Relation Name'], index: node['Index Name'],
      loops: node['Actual Loops'], rows: node['Actual Rows'], removed: node['Rows Removed by Filter'],
      cumulativeMs: node['Actual Total Time'] * node['Actual Loops'] });
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan.Plan);
  console.log('[sequential-plan] ' + JSON.stringify({ label, executionMs: plan['Execution Time'],
    planningMs: plan['Planning Time'], jit: plan.JIT,
    nodes: nodes.sort((a, b) => Number(b.cumulativeMs) - Number(a.cumulativeMs)).slice(0, 12) }));
}
