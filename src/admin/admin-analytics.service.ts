import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  AdminDateRangeDto,
  AdminOverviewDto,
  AdminPaymentStatsDto,
  adminRange,
  literalSearch,
} from '../common/pagination/admin-query';

// Provider payloads are never returned. Unknown operators stay unknown (no phone-prefix guess).
const operatorExpression = `COALESCE(
  NULLIF(p."rawCheckResponse" #>> '{data,payer,accountDetails,provider}', ''),
  NULLIF(p."rawCheckResponse" #>> '{data,recipient,accountDetails,provider}', ''),
  NULLIF(p."rawCallbackPayload" #>> '{payer,accountDetails,provider}', ''),
  NULLIF(p."rawCallbackPayload" #>> '{recipient,accountDetails,provider}', ''),
  NULLIF(p."rawCheckResponse" ->> 'operator', ''),
  NULLIF(p."rawCallbackPayload" ->> 'operator', ''),
  NULLIF(p."rawInitiationResponse" ->> 'operator', ''), 'unknown')`;
const payouts = `('wallet_payout','driver_payout','referral_payout','admin_payout')`;

@Injectable()
export class AdminAnalyticsService {
  constructor(private readonly db: DataSource) {}

  private snapshot<T>(read: (manager: EntityManager) => Promise<T>) {
    return this.db.transaction('REPEATABLE READ', async (manager) => {
      await manager.query(`SET TRANSACTION READ ONLY`);
      await manager.query(`SET LOCAL statement_timeout = '8000ms'`);
      await manager.query(`SET LOCAL TIME ZONE 'UTC'`);
      return read(manager);
    });
  }

  private period(input: AdminDateRangeDto) {
    const range = adminRange(input, true);
    return {
      from: range.from!,
      to: range.to!,
      timezone: 'UTC',
      dateField: 'createdAt',
      toExclusive: true,
    };
  }

  async overview(input: AdminOverviewDto) {
    const period = this.period(input);
    return this.snapshot(async (manager) => {
      const current = await this.tripStats(manager, period.from, period.to);
      let previous: Record<string, unknown> | null = null;
      if (input.compare === 'previous') {
        const from = new Date(
          period.from.getTime() - (period.to.getTime() - period.from.getTime()),
        );
        previous = {
          period: { ...period, from, to: period.from },
          ...(await this.tripStats(manager, from, period.from)),
        };
      }
      return {
        period,
        ...current,
        previous,
        definitions: {
          cohort:
            'Trips created in [from,to); counts reflect their current status, including private trips.',
          daily:
            'Creation day UTC: published count and current completed/cancelled counts in that same cohort; not event completion dates.',
          rates:
            'Percentage of all published trips in the cohort; null for an empty cohort.',
          ratings:
            'Recorded ratings (1–5) received by the trip driver on trips in the cohort; no inferred score. null means no rating.',
          ranking:
            'Top 10 by completed trips, then actual rating average, then driver ID.',
        },
      };
    });
  }

  private async tripStats(manager: EntityManager, from: Date, to: Date) {
    const [row] = await manager.query(
      `WITH cohort AS MATERIALIZED (
      SELECT id, "driverId", status, "departureLocation", "arrivalLocation", "createdAt"
      FROM trips WHERE "createdAt" >= $1::timestamp AND "createdAt" < $2::timestamp
    ), totals AS (
      SELECT count(*) AS total, count(*) FILTER (WHERE status='completed') AS completed,
        count(*) FILTER (WHERE status='cancelled') AS cancelled,
        count(*) FILTER (WHERE status='upcoming') AS upcoming,
        count(*) FILTER (WHERE status='ongoing') AS ongoing FROM cohort
    ), days AS (
      SELECT d::date AS day FROM generate_series(date_trunc('day',$1::timestamp),
        date_trunc('day',$2::timestamp - interval '1 microsecond'),interval '1 day') d
    ), daily AS (
      SELECT "createdAt"::date AS day, count(*) AS published,
        count(*) FILTER (WHERE status='completed') AS completed,
        count(*) FILTER (WHERE status='cancelled') AS cancelled FROM cohort GROUP BY 1
    ), driver_counts AS (
      SELECT "driverId",count(*) AS total,count(*) FILTER (WHERE status='completed') AS completed,
        count(*) FILTER (WHERE status='cancelled') AS cancelled FROM cohort GROUP BY "driverId"
    ), scores AS (
      SELECT c."driverId", avg(r.rating) AS average, count(*) AS count
      FROM cohort c JOIN ratings r ON r."tripId"::text = c.id::text AND r."ratedUserId"::text = c."driverId"::text
      WHERE r.rating BETWEEN 1 AND 5 AND r."raterId"::text <> c."driverId"::text GROUP BY c."driverId"
    ) SELECT jsonb_build_object(
      'total',total,'byStatus',jsonb_build_object('upcoming',upcoming,'ongoing',ongoing,'completed',completed,'cancelled',cancelled),
      'completionRate',100.0*completed/NULLIF(total,0),'cancellationRate',100.0*cancelled/NULLIF(total,0),
      'daily',COALESCE((SELECT jsonb_agg(jsonb_build_object('date',days.day,'published',COALESCE(daily.published,0),
        'completed',COALESCE(daily.completed,0),'cancelled',COALESCE(daily.cancelled,0)) ORDER BY days.day)
        FROM days LEFT JOIN daily USING(day)),'[]'::jsonb),
      'popularRoutes',COALESCE((SELECT jsonb_agg(x ORDER BY x.total DESC,x."departureLocation",x."arrivalLocation") FROM (
        SELECT "departureLocation","arrivalLocation",count(*) AS total FROM cohort
        GROUP BY 1,2 ORDER BY total DESC,1,2 LIMIT 10) x),'[]'::jsonb),
      'drivers',COALESCE((SELECT jsonb_agg(x ORDER BY x.completed DESC,x."averageRating" DESC NULLS LAST,x."driverId") FROM (
        SELECT d."driverId",u."firstName",u."lastName",d.total,d.completed,d.cancelled,
          s.average AS "averageRating",COALESCE(s.count,0) AS "ratingCount"
        FROM driver_counts d LEFT JOIN users u ON u.id::text=d."driverId"::text LEFT JOIN scores s ON s."driverId"=d."driverId"
        ORDER BY d.completed DESC,s.average DESC NULLS LAST,d."driverId" LIMIT 10) x),'[]'::jsonb)
      ) AS result FROM totals`,
      [from.toISOString(), to.toISOString()],
    );
    return row.result;
  }

  async paymentStats(input: AdminPaymentStatsDto) {
    const period = this.period(input);
    const groupBy = input.groupBy ?? 'day';
    const groups = {
      day: `p."createdAt"::date::text`,
      provider: 'p.provider::text',
      operator: 'p.operator',
    };
    if (!Object.hasOwn(groups, groupBy))
      throw new BadRequestException('groupBy invalide');
    return this.snapshot(async (manager) => {
      const [row] = await manager.query(
        `WITH base AS MATERIALIZED (
        SELECT p.id,p."createdAt",p.provider,p.status,p.currency,p.amount,p.purpose,
          ${operatorExpression} AS raw_operator FROM payment_transactions p
        WHERE p."createdAt" >= $1::timestamp AND p."createdAt" < $2::timestamp
      ), payments AS MATERIALIZED (
        SELECT base.*, CASE WHEN raw_operator ~ '^[A-Za-z][A-Za-z0-9_ -]{1,49}$' THEN raw_operator ELSE 'unknown' END AS operator FROM base
      ), summary AS (
        SELECT count(*) AS total, count(*) FILTER (WHERE status='succeeded') AS succeeded,
          count(*) FILTER (WHERE status='failed') AS failed,count(*) FILTER (WHERE status='cancelled') AS cancelled,
          count(*) FILTER (WHERE status IN ('pending','initiated')) AS pending FROM payments
      ) SELECT jsonb_build_object(
        'total',total,'succeeded',succeeded,'failed',failed,'cancelled',cancelled,'pending',pending,
        'successRate',100.0*succeeded/NULLIF(total,0),
        'volumes',COALESCE((SELECT jsonb_agg(x ORDER BY x.currency) FROM (
          SELECT currency,count(*) AS count,sum(amount) AS "requestedAmount",
            COALESCE(sum(amount) FILTER (WHERE status='succeeded'),0) AS "succeededAmount" FROM payments GROUP BY currency) x),'[]'::jsonb),
        'groups',COALESCE((SELECT jsonb_agg(x ORDER BY x.key,x.currency) FROM (
          SELECT ${groups[groupBy]} AS key,currency,count(*) AS count,sum(amount) AS "requestedAmount",
            count(*) FILTER (WHERE status='succeeded') AS succeeded,count(*) FILTER (WHERE status='failed') AS failed,
            count(*) FILTER (WHERE status IN ('pending','initiated')) AS pending,
            COALESCE(sum(amount) FILTER (WHERE status='succeeded'),0) AS "succeededAmount",
            100.0*count(*) FILTER (WHERE status='succeeded')/NULLIF(count(*),0) AS "successRate"
          FROM payments p GROUP BY 1,2) x),'[]'::jsonb),
        'failuresByOperator',COALESCE((SELECT jsonb_agg(x ORDER BY x.provider,x.operator,x.currency) FROM (
          SELECT provider,operator,currency,count(*) AS count,sum(amount) AS amount FROM payments WHERE status='failed' GROUP BY 1,2,3) x),'[]'::jsonb),
        'pendingPayouts', (SELECT jsonb_build_object('count',count(*),'oldestCreatedAt',min("createdAt"),
          'oldestAgeSeconds',CASE WHEN count(*)>0 THEN greatest(0,extract(epoch FROM (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-min("createdAt"))) END,
          'averageAgeSeconds',avg(greatest(0,extract(epoch FROM (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-"createdAt"))),
          'under1Hour',count(*) FILTER (WHERE "createdAt">(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-interval '1 hour'),
          'between1And24Hours',count(*) FILTER (WHERE "createdAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-interval '1 hour' AND "createdAt">(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-interval '24 hours'),
          'over24Hours',count(*) FILTER (WHERE "createdAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-interval '24 hours'))
          FROM payments WHERE status IN ('pending','initiated') AND purpose IN ${payouts})
      ) AS result FROM summary`,
        [period.from.toISOString(), period.to.toISOString()],
      );
      return {
        period,
        groupBy,
        ...row.result,
        definitions: {
          successRate:
            'Succeeded / all transactions created in the period, including pending and cancelled, percent; null if empty.',
          volumes:
            'Amounts separated by currency; requestedAmount includes every status, succeededAmount only confirmed successes. Not net revenue.',
          pendingPayouts:
            'Pending/initiated payout transactions created in the period; age since creation, not last provider check.',
          operator:
            'Provider-reported operator when stored; unknown otherwise. No inference from phone numbers.',
        },
      };
    });
  }

  async ratingsStats(input: AdminDateRangeDto) {
    const period = this.period(input);
    return this.snapshot(async (manager) => {
      const trips = await this.tripStats(manager, period.from, period.to);
      const [row] = await manager.query(
        `WITH cohort AS (
        SELECT rating FROM ratings WHERE "createdAt">=$1::timestamp AND "createdAt"<$2::timestamp AND rating BETWEEN 1 AND 5
      ) SELECT jsonb_build_object('total',count(*),'averageRating',avg(rating),
        'distribution',(SELECT jsonb_agg(jsonb_build_object('rating',stars,'count',(SELECT count(*) FROM cohort c WHERE c.rating=stars)) ORDER BY stars)
          FROM generate_series(1,5) stars)) AS result FROM cohort`,
        [period.from.toISOString(), period.to.toISOString()],
      );
      return {
        period,
        ...row.result,
        trips,
        definitions: {
          ratings:
            'Actual ratings created in the period, across all rated users. Empty average is null.',
          drivers:
            'trips.drivers: ratings received as driver on trips created in the period (not estimated from completion).',
        },
      };
    });
  }

  async promotionsStats(input: AdminDateRangeDto) {
    const period = this.period(input);
    return this.snapshot(async (manager) => {
      const [row] = await manager.query(
        `WITH cohort AS (
        SELECT "driverId" FROM trips WHERE "createdAt">=$1::timestamp AND "createdAt"<$2::timestamp
      ) SELECT jsonb_build_object(
        'totalDrivers',(SELECT count(*) FROM users WHERE "isDriver"=true),
        'newDrivers',(SELECT count(*) FROM users WHERE "isDriver"=true AND "createdAt">=$1::timestamp AND "createdAt"<$2::timestamp),
        'totalTrips',(SELECT count(*) FROM cohort),'activeDriverCount',(SELECT count(DISTINCT "driverId") FROM cohort),
        'avgTripsPerDriver',(SELECT 1.0*count(*)/NULLIF(count(DISTINCT "driverId"),0) FROM cohort),
        'referralRewards',COALESCE((SELECT jsonb_agg(x ORDER BY x.status,x."sourceType",x."sourceCurrency") FROM (
          SELECT status,"sourceType","sourceCurrency",count(*) AS count,sum("rewardTokens") AS tokens,sum("rewardAmount") AS amount
          FROM referral_rewards WHERE "createdAt">=$1::timestamp AND "createdAt"<$2::timestamp GROUP BY 1,2,3) x),'[]'::jsonb),
        'loyaltyRewards',COALESCE((SELECT jsonb_agg(x ORDER BY x.currency) FROM (
          SELECT currency,count(*) AS count,sum(amount) AS tokens FROM wallet_ledger_entries
          WHERE type='loyalty_reward' AND "createdAt">=$1::timestamp AND "createdAt"<$2::timestamp GROUP BY currency) x),'[]'::jsonb)
      ) AS result`,
        [period.from.toISOString(), period.to.toISOString()],
      );
      return {
        period,
        ...row.result,
        promotionCodes: {
          available: false,
          reason:
            'No persisted promotion-code program; frontend demo codes are not statistics.',
        },
        definitions: {
          totalDrivers:
            'All currently driver-flagged accounts (including inactive), not limited to creation period.',
          activeDriverCount:
            'Distinct drivers with at least one trip created in the period; not online presence.',
          rewards:
            'Ledger/rewards created in period, separated by status/source/currency; tokens are not money.',
        },
      };
    });
  }

  async search(value: string) {
    if (
      typeof value !== 'string' ||
      value.trim().length < 2 ||
      value.length > 160
    )
      throw new BadRequestException('Recherche : 2 à 160 caractères');
    const q = value.trim();
    const phone = q.replace(/[\s()+.-]/g, '');
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(q) ? q : null;
    const phoneTerm = /^\d{3,15}$/.test(phone) ? `%${phone}%` : null;
    return this.snapshot(async (manager) => {
      const [row] = await manager.query(
        `WITH u AS NOT MATERIALIZED (
        SELECT id,"firstName","lastName",phone,status FROM users WHERE phone ILIKE $2
      ), t AS NOT MATERIALIZED (
        SELECT id,"departureLocation","arrivalLocation",status,"departureDate" FROM trips WHERE ${uuid ? 'id = $3::uuid' : 'id::text ILIKE $1'}
      ), p AS NOT MATERIALIZED (
        SELECT id,reference,status,amount,currency FROM payment_transactions WHERE reference ILIKE $1 OR "providerReference" ILIKE $1 OR "orderNumber" ILIKE $1
      ), s AS NOT MATERIALIZED (
        SELECT id,subject,status,"createdAt" FROM support_tickets WHERE ${uuid ? 'id = $3::uuid' : 'id::text ILIKE $1'} OR subject ILIKE $1
      ) SELECT jsonb_build_object(
        'users',jsonb_build_object('total',(SELECT count(*) FROM u),'items',COALESCE((SELECT jsonb_agg(x) FROM (SELECT * FROM u ORDER BY id LIMIT 10) x),'[]'::jsonb)),
        'trips',jsonb_build_object('total',(SELECT count(*) FROM t),'items',COALESCE((SELECT jsonb_agg(x) FROM (SELECT * FROM t ORDER BY id LIMIT 10) x),'[]'::jsonb)),
        'payments',jsonb_build_object('total',(SELECT count(*) FROM p),'items',COALESCE((SELECT jsonb_agg(x) FROM (SELECT * FROM p ORDER BY id LIMIT 10) x),'[]'::jsonb)),
        'tickets',jsonb_build_object('total',(SELECT count(*) FROM s),'items',COALESCE((SELECT jsonb_agg(x) FROM (SELECT * FROM s ORDER BY "createdAt" DESC,id LIMIT 10) x),'[]'::jsonb))
      ) AS result`,
        uuid ? [literalSearch(q), phoneTerm, uuid] : [literalSearch(q), phoneTerm],
      );
      return { ...row.result, limitPerType: 10 };
    });
  }
}
