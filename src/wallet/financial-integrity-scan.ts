import type { DataSource, EntityManager } from 'typeorm';

/** Read-only audit: bounded pages, short SQL snapshots, never repairs a balance.
 * A failed/incomplete sweep throws: it must never be reported as zero anomalies. */
export async function scanFinancialIntegrity(db: DataSource, assertLease: () => void, pageSize = 200) {
  const cutoff = new Date();
  const expiresAt = Date.now() + 45000;
  const limit = Math.min(1000, Math.max(1, pageSize));
  const scan = async (kind: 'wallet' | 'booking') => {
    let cursor: string | null = null, anomalies = 0;
    while (true) {
      assertLease();
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) throw new Error('FINANCIAL_AUDIT_INCOMPLETE: time budget exceeded');
      const row = await db.transaction(async (manager: EntityManager) => {
        await manager.query(`SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout','500ms',true)`,
          [`${Math.min(2500, remaining)}ms`]);
        const [result] = await manager.query(kind === 'wallet' ? `
          WITH page AS MATERIALIZED (SELECT id,balance FROM wallet_accounts
            WHERE ($1::uuid IS NULL OR id>$1::uuid) AND "createdAt"<=$2 ORDER BY id LIMIT $3)
          SELECT count(*)::int inspected, max(id::text) cursor,
            count(*) FILTER (WHERE balance <> COALESCE(journal.amount,0))::int anomalies
          FROM page LEFT JOIN LATERAL (
            SELECT sum(amount) amount FROM wallet_ledger_entries WHERE "accountId"=page.id
          ) journal ON true`
          : `WITH page AS MATERIALIZED (SELECT id,"paymentMode","paymentStatus",status,"droppedOff" FROM bookings
            WHERE ($1::uuid IS NULL OR id>$1::uuid) AND "createdAt"<=$2 ORDER BY id LIMIT $3)
          SELECT count(*)::int inspected,max(id::text) cursor,
            count(*) FILTER (WHERE "paymentMode"='points' AND "paymentStatus"='succeeded'
              AND (status='completed' OR "droppedOff"=true) AND NOT EXISTS (
                SELECT 1 FROM wallet_ledger_entries debit WHERE debit."relatedEntityType"='booking'
                  AND debit."relatedEntityId"=page.id AND debit.type='booking_payment'))::int anomalies
          FROM page`, [cursor, cutoff, limit]);
        return result;
      });
      if (!row || !Number.isFinite(Number(row.anomalies))) throw new Error('FINANCIAL_AUDIT_INCOMPLETE: invalid result');
      anomalies += Number(row.anomalies);
      if (Number(row.inspected) < limit) return anomalies;
      if (!row.cursor || row.cursor === cursor) throw new Error('FINANCIAL_AUDIT_INCOMPLETE: cursor did not advance');
      cursor = row.cursor;
    }
  };
  // Sequential phases leave pool capacity for live requests. Old anomalies remain in scope.
  const unsafeAnomalies = await scan('booking');
  const walletBalanceMismatches = await scan('wallet');
  assertLease();
  return { unsafeAnomalies, walletBalanceMismatches };
}
