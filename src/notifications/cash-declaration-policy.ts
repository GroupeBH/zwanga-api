/** SQL aliases are internal constants, never request input. No casts of unvalidated JSON amounts. */
export function cashDeclarationRelevantSql(
  alias: 'n' | 'notification',
): string {
  return `EXISTS (SELECT 1 FROM bookings cash_b JOIN trips cash_t ON cash_t.id = cash_b."tripId"
    WHERE cash_b.id = CASE WHEN ${alias}.data ->> 'bookingId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN (${alias}.data ->> 'bookingId')::uuid END
    AND cash_t."driverId"::text = ${alias}."userId"::text
    AND ${alias}.data ->> 'driverId' = ${alias}."userId"::text AND ${alias}.data ->> 'role' = 'driver'
    AND cash_b."tripId"::text = ${alias}.data ->> 'tripId'
    AND cash_b.status = 'completed' AND cash_b."droppedOff" = true
    AND cash_b."paymentMode" = 'cash' AND cash_b."paymentStatus" = 'not_required'
    AND cash_b."cashReceivedAt" IS NULL AND cash_b."paymentAmount" > 0
    AND to_jsonb(cash_b."paymentAmount") = ${alias}.data -> 'amount'
    AND cash_b."paymentCurrency" = ${alias}.data ->> 'currency')`;
}
