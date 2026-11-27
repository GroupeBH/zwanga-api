/** Read-only SQL port of creditSchedule for global ordering before LIMIT.
 * UTC month arithmetic starts from the original date (not the previous due date).
 * Equivalence, rounding, leap years and due-at boundaries are tested on PostgreSQL.
 * $1: asOf, $2: CREDIT_COST_VERSION. No caller text is interpolated.
 */
export const COLLECTION_BALANCES_CTE = `
active AS (
  SELECT c.id,c."driverId",c.label,c."assetKind",c."policyVersion",c."principalMinor",c."paidMinor",
    c."activatedAt",c."costDisclosureVersion",c."installmentCount",c."installmentPeriod",
    p."scheduleVersion",p."scheduleBaselineMinor",p.snapshot
  FROM asset_credits c LEFT JOIN pro_credit_contracts p ON p."creditId"=c.id
  WHERE c.status='active' AND c."paidMinor"<c."principalMinor"
), team_dates AS (
  SELECT a.*,g.ordinal, floor(a."principalMinor"::numeric/10/a."installmentCount")*10 AS ordinary,
    (date_trunc('milliseconds',a."activatedAt" AT TIME ZONE 'UTC') + CASE WHEN a."installmentPeriod"='week'
      THEN make_interval(days => 7*g.ordinal) ELSE make_interval(months => g.ordinal) END) AT TIME ZONE 'UTC' AS "dueAt"
  FROM active a CROSS JOIN LATERAL generate_series(1,a."installmentCount") g(ordinal)
  WHERE a."policyVersion"<>'zwanga-pro-v1' AND a."costDisclosureVersion"=$2
    AND a."installmentPeriod" IN ('week','month') AND a."activatedAt" IS NOT NULL
), team_installments AS (
  SELECT id,ordinal,"dueAt",
    CASE WHEN ordinal="installmentCount" THEN "principalMinor"-ordinary*(ordinal-1) ELSE ordinary END AS amount,
    CASE WHEN ordinal="installmentCount" THEN "principalMinor" ELSE ordinary*ordinal END AS cumulative,
    "paidMinor"::numeric AS paid
  FROM team_dates
), catalogue_installments AS (
  SELECT a.id,i.ordinal,i."dueAt",i."amountMinor"::numeric AS amount,
    sum(i."amountMinor") OVER(PARTITION BY a.id ORDER BY i.ordinal ROWS UNBOUNDED PRECEDING) AS cumulative,
    (a."paidMinor"-a."scheduleBaselineMinor")::numeric AS paid
  FROM active a JOIN pro_credit_installments i ON i."creditId"=a.id AND i.version=a."scheduleVersion"
  WHERE a."policyVersion"='zwanga-pro-v1'
), uncovered AS (
  SELECT s.*,least(amount,greatest(0,cumulative-paid)) AS remaining FROM (
    SELECT *, 'team'::text AS source FROM team_installments
    UNION ALL SELECT *, 'catalogue'::text AS source FROM catalogue_installments
  ) s
), dated AS (
  SELECT *,CASE WHEN source='team' THEN "dueAt"<=$1::timestamptz ELSE "dueAt"<$1::timestamptz END AS overdue
  FROM uncovered WHERE remaining>0
), balances AS (
  SELECT a.id,a."driverId",a.label,d.source,
    CASE WHEN d.source='team' THEN a."assetKind" ELSE a.snapshot->'product'->>'kind' END AS kind,
    a."principalMinor"-a."paidMinor" AS "remainingMinor",
    sum(d.remaining) FILTER(WHERE d.overdue) AS "lateMinor",
    greatest(0,floor(extract(epoch FROM ($1::timestamptz-min(d."dueAt") FILTER(WHERE d.overdue)))/86400))::integer AS "daysLate",
    min(d."dueAt") FILTER(WHERE NOT d.overdue) AS "nextDueAt"
  FROM active a JOIN dated d ON d.id=a.id
  GROUP BY a.id,a."driverId",a.label,d.source,a."assetKind",a.snapshot,a."principalMinor",a."paidMinor"
  HAVING sum(d.remaining) FILTER(WHERE d.overdue)>0
)`;

export const COLLECTION_DEBTORS_SQL = `WITH ${COLLECTION_BALANCES_CTE},
debtors AS (
  SELECT "driverId",max("daysLate") AS "daysLate",sum("lateMinor") AS "lateMinor" FROM balances GROUP BY "driverId"
), page AS (
  SELECT * FROM debtors WHERE "daysLate" BETWEEN $3 AND $4 AND ($5::integer IS NULL
    OR "daysLate"<$5 OR ("daysLate"=$5 AND "lateMinor"<$6::numeric)
    OR ("daysLate"=$5 AND "lateMinor"=$6::numeric AND "driverId">$7::uuid))
  ORDER BY "daysLate" DESC,"lateMinor" DESC,"driverId" LIMIT $8
)
SELECT d."driverId",u."firstName",u."lastName",u.phone,
  CASE WHEN NOT u."isActive" AND u.status::text='active' THEN 'inactive' ELSE u.status::text END AS "accountStatus",
  d."daysLate",d."lateMinor"::text,contracts.items AS contracts,last_action.item AS "lastAction"
FROM page d JOIN users u ON u.id=d."driverId"
CROSS JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('id',b.id,'source',b.source,'label',b.label,'kind',b.kind,
    'daysLate',b."daysLate",'lateMinor',b."lateMinor"::text,'remainingMinor',b."remainingMinor"::text,
    'nextDueAt',to_char(b."nextDueAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    ORDER BY b."daysLate" DESC,b."lateMinor" DESC,b.id) AS items FROM balances b WHERE b."driverId"=d."driverId"
) contracts
LEFT JOIN LATERAL (
  SELECT jsonb_build_object('kind',a.detail->>'kind','outcome',a.detail->>'outcome',
    'createdAt',to_char(a."createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'promisedAt',a.detail->>'promisedAt','promisedAmountMinor',a.detail->>'promisedAmountMinor') AS item
  FROM asset_credits c JOIN pro_credit_audit a ON a."creditId"=c.id
  WHERE c."driverId"=d."driverId" AND a.action='recovery_action' AND a."createdAt"<=$1::timestamptz
  ORDER BY a."createdAt" DESC,a.id DESC LIMIT 1
) last_action ON true
ORDER BY d."daysLate" DESC,d."lateMinor" DESC,d."driverId"`;
