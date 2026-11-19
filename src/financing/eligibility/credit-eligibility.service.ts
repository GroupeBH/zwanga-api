import { Injectable, NotFoundException } from '@nestjs/common';
import { CreditStore } from '../shared/credit.store';
import { EntityManager } from 'typeorm';
import type { FactsRow } from '../shared/credit.rows';

@Injectable()
export class CreditEligibilityService {
  constructor(private readonly store: CreditStore) {}

  async facts(m: EntityManager, driverId: string) {
    const [f] = await m.query<FactsRow[]>(
      `SELECT (u."isActive" AND u."isDriver" AND u.status NOT IN ('inactive','suspended')) AS "activeDriver",
      COALESCE((SELECT k.status='approved' FROM kyc_documents k WHERE k."userId"=u.id ORDER BY k."createdAt" DESC,k.id DESC LIMIT 1),false) AS "kycApproved",
      greatest(0,extract(day FROM now()-u."createdAt"))::integer AS "accountDays",
      (SELECT count(DISTINCT e."tripId")::integer FROM driver_earnings e WHERE e."driverId"=u.id AND e.status IN ('available','paid')) AS "settledTrips",
      (SELECT floor(coalesce(sum(e."netAmount"),0)*100)::text FROM driver_earnings e WHERE e."driverId"=u.id AND e.status IN ('available','paid')) AS "revenueMinor",
      (SELECT count(*)::integer FROM asset_credits c WHERE c."driverId"=u.id AND c.status IN ('accepted','active')) AS "activeCredits",
      EXISTS(SELECT 1 FROM asset_credits c WHERE c."driverId"=u.id AND c.status='active' AND (c."dueMinor">0 OR EXISTS(
        SELECT 1 FROM pro_credit_contracts pc WHERE pc."creditId"=c.id AND c."paidMinor"-pc."scheduleBaselineMinor" <
          (SELECT coalesce(sum(i."amountMinor"),0) FROM pro_credit_installments i WHERE i."creditId"=c.id AND i.version=pc."scheduleVersion" AND i."dueAt"<now())))) AS overdue
      FROM users u WHERE u.id=$1`,
      [driverId],
    );
    if (!f) throw new NotFoundException('Conducteur introuvable.');
    return f;
  }
}
