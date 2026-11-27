import { Injectable } from '@nestjs/common';
import { CreditStore } from '../shared/credit.store';
import type { CreditActor } from '../shared/credit.store';
import type { IdRow } from '../shared/credit.rows';

@Injectable()
export class CreditReportingService {
  constructor(private readonly store: CreditStore) {}

  async overview(actor: CreditActor) {
    return this.store.read(async (m) => {
      await this.store.authorize(m, actor, [
        'manager',
        'accountant',
        'collector',
        'auditor',
      ]);
      const totals = await m.query<
        {
          creditorId: string;
          status: string;
          count: number;
          principalMinor: string;
          paidMinor: string;
          remainingMinor: string;
        }[]
      >(`SELECT p."creditorId",c.status,count(*)::integer AS count,
      sum(c."principalMinor")::text AS "principalMinor",sum(c."paidMinor")::text AS "paidMinor",
      sum(c."principalMinor"-c."paidMinor")::text AS "remainingMinor"
      FROM asset_credits c JOIN pro_credit_contracts p ON p."creditId"=c.id GROUP BY p."creditorId",c.status`);
      const [queue] = await m.query<
        { pending: number; oldestSeconds: number; retrying: number }[]
      >(`SELECT count(*)::integer AS pending,
      coalesce(max(extract(epoch FROM now()-"updatedAt")),0)::integer AS "oldestSeconds",
      count(*) FILTER(WHERE attempts>0)::integer AS retrying FROM pro_credit_work WHERE version>"processedVersion"`);
      const mismatches = await m.query<
        IdRow[]
      >(`SELECT c.id FROM asset_credits c JOIN pro_credit_contracts p ON p."creditId"=c.id
      WHERE c.status IN ('active','settled') AND (
        c."paidMinor"<p."scheduleBaselineMinor"
        OR
        c."paidMinor"<>(SELECT coalesce(sum(e."amountMinor"),0) FROM asset_credit_entries e WHERE e."creditId"=c.id)
        OR c."principalMinor"-c."paidMinor"<>(SELECT coalesce(sum(l.debit-l.credit),0) FROM pro_credit_ledger_lines l WHERE l."creditId"=c.id AND l.account='credit_receivable'))
      ORDER BY c.id LIMIT 100`);
      const overdue = await m.query<
        {
          id: string;
          driverId: string;
          overdueDays: number;
          lateMinor: string;
        }[]
      >(`SELECT c.id,c."driverId",greatest(0,extract(day FROM now()-min(i."dueAt")))::integer AS "overdueDays",
      sum(least(i."amountMinor",greatest(0,i.cumulative-(c."paidMinor"-p."scheduleBaselineMinor"))))::text AS "lateMinor"
      FROM asset_credits c JOIN pro_credit_contracts p ON p."creditId"=c.id
      JOIN (SELECT *,sum("amountMinor") OVER(PARTITION BY "creditId",version ORDER BY ordinal) AS cumulative FROM pro_credit_installments) i
      ON i."creditId"=c.id AND i.version=p."scheduleVersion"
      WHERE c.status='active' AND i."dueAt"<now() AND i.cumulative>c."paidMinor"-p."scheduleBaselineMinor"
      GROUP BY c.id ORDER BY min(i."dueAt") LIMIT 100`);
      return {
        currency: 'CDF',
        totals,
        queue,
        reconciliation: { mismatches, limit: 100 },
        overdue,
        overdueLimit: 100,
      };
    });
  }
}
