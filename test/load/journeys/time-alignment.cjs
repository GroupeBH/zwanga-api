'use strict';

// timestamp WITHOUT time zone is decoded in the Node process's local timezone.
// A mixed Windows/UTC lab silently makes fresh invitations appear an hour old.
// Check the real driver decoding before fixtures, sockets or traffic are created.
async function verifyTimeAlignment(db) {
  const nodeOffsetMinutes = new Date().getTimezoneOffset();
  if (process.env.TZ !== 'UTC' || nodeOffsetMinutes !== 0)
    throw new Error('Journey preflight: Node must use TZ=UTC');
  const [row] = await db.query(`SELECT CURRENT_TIMESTAMP AS zoned,
    LOCALTIMESTAMP AS local, current_setting('TimeZone') AS "databaseTimezone"`);
  const timestampOffsetMs = row?.local instanceof Date && row?.zoned instanceof Date
    ? row.local.getTime() - row.zoned.getTime() : NaN;
  if (row?.databaseTimezone !== 'UTC' || !Number.isFinite(timestampOffsetMs) || timestampOffsetMs !== 0)
    throw new Error('Journey preflight: PostgreSQL/Node timestamp timezone mismatch');
  return { nodeTimezone: process.env.TZ, nodeOffsetMinutes,
    databaseTimezone: row.databaseTimezone, timestampOffsetMs,
    checkedAt: row.zoned.toISOString() };
}

module.exports = { verifyTimeAlignment };
