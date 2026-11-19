import { Injectable, Logger } from '@nestjs/common';
import { CreditStore } from '../shared/credit.store';
import { Interval } from '@nestjs/schedule';

@Injectable()
export class CreditRemindersWorker {
  private reminding = false;
  private readonly logger = new Logger(CreditRemindersWorker.name);
  constructor(private readonly store: CreditStore) {}

  @Interval(60000)
  async reminders() {
    if (this.reminding) return;
    this.reminding = true;
    try {
      await this.store.db.transaction(async (m) => {
        const rows = await m.query<
          { id: string; driverId: string }[]
        >(`SELECT c.id,c."driverId" FROM asset_credits c JOIN pro_credit_contracts p ON p."creditId"=c.id
          WHERE c.status IN ('active','settled') AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n."eventKey"='pro:reminder:'||c.id::text||':'||(now() AT TIME ZONE 'UTC')::date::text)
          AND ((c.status='active' AND c."paidMinor"-p."scheduleBaselineMinor" < (SELECT coalesce(sum(i."amountMinor"),0) FROM pro_credit_installments i
            WHERE i."creditId"=c.id AND i.version=p."scheduleVersion" AND i."dueAt"<now()+interval '7 days'))
            OR EXISTS(SELECT 1 FROM pro_credit_documents d WHERE d."creditId"=c.id AND d."expiresAt" BETWEEN now() AND now()+interval '30 days'))
          ORDER BY c.id LIMIT 100 FOR UPDATE OF p SKIP LOCKED`);
        const day = new Date().toISOString().slice(0, 10);
        for (const c of rows)
          await this.store.notify(
            m,
            c.driverId,
            c.id,
            `reminder:${c.id}:${day}`,
          );
      });
    } catch {
      this.logger.error('PRO_CREDIT_REMINDERS_RETRY');
    } finally {
      this.reminding = false;
    }
  }
}
