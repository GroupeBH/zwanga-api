/** Copy plain SQL projections (dates, JSON, arrays, scalar values), not entities.
 * Each caller can mutate its result without changing another concurrent read.
 * Construct dates in this realm too: native structuredClone may cross a VM
 * boundary, while ORM hydration and business checks use instanceof Date.
 */
export function copySqlProjection<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(item => copySqlProjection(item)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copySqlProjection(item)])) as T;
  }
  return value;
}
