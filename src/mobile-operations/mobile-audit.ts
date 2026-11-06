import { createHash } from 'node:crypto';
import { EntityManager } from 'typeorm';
export const mobileAudit = (
  m: EntityManager,
  actorId: string | null,
  action: string,
  subjectId: string,
  details: object = {},
) =>
  m.query(
    `INSERT INTO store_audit_logs ("actorId",action,"subjectId",details) VALUES ($1,$2,$3,$4)`,
    [actorId, `mobile.${action}`, subjectId, JSON.stringify(details)],
  );
export function requestHash(value: unknown): string {
  const canonical = (v: any): any =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .filter((k) => v[k] !== undefined)
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
