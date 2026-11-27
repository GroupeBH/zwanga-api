import { DispatchResponseAdmission } from './dispatch-response-admission';

type Source = { options?: { extra?: { max?: number }; poolSize?: number } };
const budgets = new WeakMap<Source, DispatchResponseAdmission>();

/** Separate from response admission: a response must not queue behind a flood
 * of received/displayed/audio receipts. No success is returned until COMMIT.
 * This is local pressure control, NOT a substitute for PostgreSQL locking. */
export function receiptAdmission(db: Source): DispatchResponseAdmission {
  let budget = budgets.get(db);
  if (!budget) {
    const size = Number(db.options?.extra?.max ?? db.options?.poolSize ?? 10);
    if (!Number.isSafeInteger(size) || size < 1) throw new Error('Invalid SQL pool capacity');
    budget = new DispatchResponseAdmission(Math.max(1, Math.min(2, Math.floor(size * .2))),
      32, 750, undefined, 'NOTIFICATION_RECEIPT_BUSY');
    budgets.set(db, budget);
  }
  return budget;
}
