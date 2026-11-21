import { Injectable, Logger } from '@nestjs/common';
import { CreditStore } from '../shared/credit.store';
import { CreditLedgerService } from '../ledger/credit-ledger.service';
import { Interval } from '@nestjs/schedule';
import type { EarningRow, AllocationRow, IdRow } from '../shared/credit.rows';
import { cents, floorWallet, decimal, minimum } from '../shared/money';
import { repaymentAllocation } from './repayment-allocation.policy';
import { EntityManager } from 'typeorm';

@Injectable()
export class TripCreditRepaymentWorker {
  private running = false;
  private readonly logger = new Logger(TripCreditRepaymentWorker.name);
  constructor(
    private readonly store: CreditStore,
    private readonly finance: CreditLedgerService,
  ) {}

  @Interval(15000)
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = await this.store.db.query<{ earningId: string }[]>(
        'SELECT "earningId" FROM pro_credit_work WHERE version>"processedVersion" AND "retryAt"<=now() ORDER BY "retryAt","earningId" LIMIT 30',
      );
      for (const job of jobs) {
        try {
          await this.process(job.earningId);
        } catch {
          this.logger.error(
            'PRO_CREDIT_WORK_RETRY: reservation preserved; reconciliation required if persistent.',
          );
          await this.store.db.query(
            `UPDATE pro_credit_work SET attempts=least(attempts+1,1000),
            "retryAt"=now()+make_interval(secs=>least(600,15*power(2,least(attempts,6)))::integer)
            WHERE "earningId"=$1 AND version>"processedVersion"`,
            [job.earningId],
          );
        }
      }
    } catch {
      this.logger.error('PRO_CREDIT_QUEUE_UNAVAILABLE');
    } finally {
      this.running = false;
    }
  }

  async process(earningId: string) {
    return this.store.db.transaction(async (m) => {
      await m.query("SET LOCAL lock_timeout='2s'");
      await m.query("SET LOCAL statement_timeout='10s'");
      const [owner] = await m.query<{ driverId: string }[]>(
        'SELECT "driverId" FROM driver_earnings WHERE id=$1',
        [earningId],
      );
      if (!owner) return;
      // Serialize with withdrawal reservations, then earning, then the common credit lock.
      await this.store.driverLock(m, owner.driverId);
      const [e] = await m.query<EarningRow[]>(
        'SELECT * FROM driver_earnings WHERE id=$1 FOR UPDATE',
        [earningId],
      );
      const [job] = await m.query<{ version: number }[]>(
        'SELECT * FROM pro_credit_work WHERE "earningId"=$1 AND version>"processedVersion" FOR UPDATE SKIP LOCKED',
        [earningId],
      );
      if (!job) return;
      // A payout status is not a refund. Preserve prior deductions on already paid earnings.
      // Financial reversals use the authoritative cancelled state instead.
      if (e.status === 'paid') {
        await m.query(
          'UPDATE driver_earnings SET "proCreditPending"=false WHERE id=$1',
          [earningId],
        );
        await m.query(
          'UPDATE pro_credit_work SET "processedVersion"=version,attempts=0 WHERE "earningId"=$1',
          [earningId],
        );
        return;
      }
      await this.store.creditLock(m, e.driverId);
      const [booking] = await m.query<
        { paymentStatus: string; paymentMode: string }[]
      >('SELECT "paymentStatus","paymentMode" FROM bookings WHERE id=$1', [
        e.bookingId,
      ]);
      const settled =
        e.status === 'available' &&
        e.currency === 'CDF' &&
        ['electronic', 'points'].includes(e.paymentMode) &&
        booking?.paymentStatus === 'succeeded' &&
        booking.paymentMode === e.paymentMode;
      const prior = await m.query<AllocationRow[]>(
        'SELECT * FROM pro_credit_allocations WHERE "earningId"=$1 ORDER BY "creditId"',
        [earningId],
      );
      // A provider correction/reversal is compensated, never an edit to a posted journal.
      for (const a of prior)
        if (BigInt(a.driverMinor) + BigInt(a.platformMinor) > 0n)
          await this.reverse(m, e, a, job.version);
      const credits = await m.query<IdRow[]>(
        `SELECT c.id FROM asset_credits c JOIN pro_credit_contracts p ON p."creditId"=c.id
        WHERE c."driverId"=$1 AND c.status='active' AND c."activatedAt"<=$2 AND p."mandateRevokedAt" IS NULL AND p."mandateUntil">now()
        AND p."deliveryState" NOT IN ('rejected','returned')
        ORDER BY c."activatedAt",c.id`,
        [e.driverId, e.createdAt],
      );
      const netAfterLegacy = cents(e.netAmount) - cents(e.assetRepaymentAmount);
      const baseNet =
        settled && netAfterLegacy > 0n ? floorWallet(netAfterLegacy) : 0n;
      // Earlier payout reservations may predate a fare correction. Never take their funds.
      const [balance] = await m.query<{ available: string }[]>(
        `SELECT greatest(0,
        coalesce((SELECT sum("netAmount"-"assetRepaymentAmount"-"proRepaymentAmount") FROM driver_earnings
          WHERE "driverId"=$1 AND id<>$2 AND status='available' AND NOT "proCreditPending"),0)
        + $3::numeric - coalesce((SELECT sum(amount) FROM driver_payouts WHERE "driverId"=$1 AND status IN ('pending','initiated','succeeded')),0))::text AS available`,
        [e.driverId, earningId, decimal(baseNet)],
      );
      const commissionBase = settled
        ? floorWallet(cents(e.commissionAmount))
        : 0n;
      let driverAvailable = minimum(
          baseNet,
          floorWallet(cents(balance.available)),
        ),
        commissionAvailable = commissionBase,
        driverTotal = 0n;
      for (const candidate of settled ? credits : []) {
        const c = await this.store.contract(m, candidate.id, undefined, true);
        // A shared trip can have several settled bookings. Its fixed charge applies only once.
        const [fixed] = await m.query<{ used: string }[]>(
          `SELECT coalesce(sum(a."fixedMinor"),0)::text AS used
          FROM pro_credit_allocations a JOIN driver_earnings x ON x.id=a."earningId"
          WHERE a."creditId"=$1 AND x."tripId"=$2 AND x.id<>$3`,
          [c.id, e.tripId, earningId],
        );
        const configuredFixed = BigInt(
          c.snapshot.policy.rules.fixedPerTripMinor,
        );
        const fixedRemaining =
          configuredFixed > BigInt(fixed.used)
            ? configuredFixed - BigInt(fixed.used)
            : 0n;
        const allocation = repaymentAllocation(
          {
            ...c.snapshot.policy.rules,
            fixedPerTripMinor: fixedRemaining.toString(),
          },
          baseNet,
          commissionBase,
          BigInt(c.principalMinor) - BigInt(c.paidMinor),
          driverAvailable,
        );
        const driver = allocation.driver,
          platform = minimum(allocation.platform, commissionAvailable),
          total = driver + platform;
        if (total === 0n) continue;
        const source = `trip:${earningId}:${c.id}:v${job.version}`;
        const detail = {
          purpose: 'repayment',
          earningId,
          bookingId: e.bookingId,
          paymentMode: e.paymentMode,
          netMinor: baseNet.toString(),
          commissionMinor: cents(e.commissionAmount).toString(),
          rulesVersion: c.snapshot.policy.version,
          status: 'CONFIRMED',
        };
        const journals: string[] = [];
        if (driver)
          journals.push(
            await this.finance.journal(
              m,
              c,
              `${source}:driver`,
              'driver_payable',
              'credit_receivable',
              driver,
              detail,
            ),
          );
        if (platform)
          journals.push(
            await this.finance.journal(
              m,
              c,
              `${source}:commission`,
              'platform_commission_allocation',
              'credit_receivable',
              platform,
              detail,
            ),
          );
        await m.query(
          `UPDATE asset_credits SET "paidMinor"="paidMinor"+$2,
          status=CASE WHEN "paidMinor"+$2="principalMinor" THEN 'settled' ELSE 'active' END WHERE id=$1`,
          [c.id, total.toString()],
        );
        await m.query(
          `INSERT INTO asset_credit_entries("creditId","driverId","bookingId",kind,"amountMinor","sourceKey") VALUES($1,$2,$3,'trip_earning',$4,$5)`,
          [c.id, c.driverId, e.bookingId, total.toString(), source],
        );
        await m.query(
          `INSERT INTO pro_credit_allocations("earningId","creditId","driverMinor","platformMinor","journalIds",version,"fixedMinor") VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT("earningId","creditId") DO UPDATE SET "driverMinor"=$3,"platformMinor"=$4,"journalIds"=$5,version=$6,"fixedMinor"=$7`,
          [
            earningId,
            c.id,
            driver.toString(),
            platform.toString(),
            JSON.stringify(journals),
            job.version,
            minimum(driver, fixedRemaining).toString(),
          ],
        );
        await this.store.notify(m, c.driverId, c.id, source);
        driverAvailable -= driver;
        commissionAvailable -= platform;
        driverTotal += driver;
      }
      await m.query(
        'UPDATE driver_earnings SET "proRepaymentAmount"=$2,"proCreditPending"=false WHERE id=$1',
        [earningId, decimal(driverTotal)],
      );
      await m.query(
        'UPDATE pro_credit_work SET "processedVersion"=version,attempts=0 WHERE "earningId"=$1',
        [earningId],
      );
    });
  }

  private async reverse(
    m: EntityManager,
    earning: EarningRow,
    allocation: AllocationRow,
    version: number,
  ) {
    const c = await this.store.contract(
      m,
      allocation.creditId,
      undefined,
      true,
    );
    const total =
      BigInt(allocation.driverMinor) + BigInt(allocation.platformMinor);
    for (const journalId of allocation.journalIds) {
      await m.query(
        `INSERT INTO pro_credit_journals("creditId","creditorId",currency,"sourceKey","debitAccount","creditAccount","amountMinor","reversesId",detail)
        SELECT "creditId","creditorId",currency,$2,"creditAccount","debitAccount","amountMinor",id,$3 FROM pro_credit_journals WHERE id=$1`,
        [
          journalId,
          `reverse:${journalId}`,
          JSON.stringify({
            purpose: 'repayment_reversal',
            earningId: earning.id,
            version,
            status: 'REVERSED',
          }),
        ],
      );
    }
    await m.query(
      'UPDATE asset_credits SET "paidMinor"="paidMinor"-$2,status=\'active\' WHERE id=$1',
      [c.id, total.toString()],
    );
    await m.query(
      `INSERT INTO asset_credit_entries("creditId","driverId","bookingId",kind,"amountMinor","sourceKey") VALUES($1,$2,$3,'reversal',$4,$5)`,
      [
        c.id,
        c.driverId,
        earning.bookingId,
        (-total).toString(),
        `reverse:${earning.id}:${c.id}:v${version}`,
      ],
    );
    await m.query(
      'UPDATE pro_credit_allocations SET "driverMinor"=0,"platformMinor"=0,"fixedMinor"=0,"journalIds"=\'[]\',version=$3 WHERE "earningId"=$1 AND "creditId"=$2',
      [earning.id, c.id, version],
    );
    await this.store.audit(
      m,
      null,
      'earning_repayment_reversed',
      { earningId: earning.id, version },
      c.id,
    );
  }
}
