import { DataSource } from 'typeorm';

/** This function does not contact AWS. The deployment orchestrator must first
 * prove that all old service tasks are STOPPED, not merely deregistered. */
export async function activateFinancialRollout(db: DataSource): Promise<void> {
  await db.transaction(async (manager) => {
    await manager.query(`SET LOCAL lock_timeout = '5s'`);
    await manager.query(`SET LOCAL statement_timeout = '60s'`);
    await manager.query('SELECT pg_advisory_xact_lock(782341, 1)');
    const [state] = await manager.query(
      'SELECT enabled FROM financial_rollout WHERE id = true FOR UPDATE',
    );
    if (!state) throw new Error('Missing financial rollout state');
    if (state.enabled) return;
    // Exclude concurrent registrations while repairing ambiguous legacy tokens.
    await manager.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    await manager.query(`UPDATE users SET "fcmToken" = NULL WHERE "fcmToken" IN (
      SELECT "fcmToken" FROM users WHERE "fcmToken" IS NOT NULL GROUP BY "fcmToken" HAVING count(*) > 1)`);
    await manager.query(
      `DELETE FROM driver_notification_clients WHERE "userId" IN (SELECT id FROM users WHERE "fcmToken" IS NULL)`,
    );
    await manager.query(
      `DELETE FROM app_update_clients WHERE "userId" IN (SELECT id FROM users WHERE "fcmToken" IS NULL)`,
    );
    // Cleaning token ownership schedules the deferred welcome trigger. Flush it
    // before CREATE INDEX, which PostgreSQL forbids with pending table events.
    await manager.query(
      'SET CONSTRAINTS users_verified_welcome_bonus IMMEDIATE',
    );
    await manager.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_push_token" ON users ("fcmToken") WHERE "fcmToken" IS NOT NULL`,
    );
    await manager.query(
      'UPDATE financial_rollout SET enabled=true,"activatedAt"=now() WHERE id=true',
    );
    // Accepted/in-flight legacy rides retain policy 0. Only uncommitted requests
    // enter the new policy, without retroactive commission on completed rides.
    await manager.query(
      `UPDATE bookings SET "cashCommissionPolicyVersion"=2 WHERE status='pending' AND "cashCommissionPolicyVersion"=0`,
    );
    await manager.query(
      `UPDATE trip_requests SET "cashCommissionPolicyVersion"=2 WHERE status='pending' AND "cashCommissionPolicyVersion"=0`,
    );
  });
}

export async function assertLegacyRolloutSafe(db: DataSource): Promise<void> {
  const [tables] = await db.query(
    `SELECT to_regclass('cash_commissions') AS cash, to_regclass('financial_rollout') AS rollout`,
  );
  if (tables.cash) {
    const [history] = await db.query(
      'SELECT EXISTS(SELECT 1 FROM cash_commissions) AS present',
    );
    if (history.present)
      throw new Error(
        'Financial history exists: refusing a legacy-server rollout. A coordinated recovery is required.',
      );
  }
  if (tables.rollout) {
    const [state] = await db.query(
      'SELECT enabled FROM financial_rollout WHERE id=true',
    );
    if (state?.enabled)
      throw new Error(
        'Cash policy is already active: legacy backend rollback is unsafe.',
      );
  }
}
