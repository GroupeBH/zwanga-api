import type { EntityManager } from 'typeorm';

/** Same per-statement budgets, one round trip; true keeps both transaction-local. */
export async function setDispatchTransactionTimeouts(manager: EntityManager): Promise<void> {
  await manager.query(`SELECT set_config('lock_timeout','2s',true),
    set_config('statement_timeout','5s',true)`);
}
