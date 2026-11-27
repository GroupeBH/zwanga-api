import type { DataSource } from 'typeorm';

export interface CashExceptionNotice {
  requiresDriverAcknowledgment: true;
  message: string;
  occurrence?: number;
  penaltyAmount?: number;
  alreadyCountedForTrip?: boolean;
  suspensionAfterRide?: boolean;
}

/** Do not expose a driver's history or penalties to another passenger. */
export async function readCashExceptionPolicy(
  db: DataSource,
  driverId: string,
  bookingId: string,
  isDriver: boolean,
) {
  const rows = await db.query<
    {
      active: boolean;
      pending: boolean;
      occurrence: number;
      alreadyCounted: boolean;
    }[]
  >(
    `
    SELECT u."isActive" AND u.status='active' AS active,
      EXISTS(SELECT 1 FROM driver_cash_exceptions WHERE "bookingId"=$2 AND "driverId"=$1 AND "confirmedAt" IS NULL) AS pending,
      i."tripId" IS NOT NULL AS "alreadyCounted",
      COALESCE(i.occurrence,(SELECT COALESCE(MAX(occurrence),0)+1 FROM driver_cash_exception_trips WHERE "driverId"=$1)) AS occurrence
    FROM users u
    LEFT JOIN driver_cash_exception_trips i ON i."driverId"=u.id AND i."tripId"=(SELECT "tripId" FROM bookings WHERE id=$2)
    WHERE u.id=$1 AND (EXISTS(SELECT 1 FROM driver_cash_exception_rollout WHERE id AND enabled)
      OR EXISTS(SELECT 1 FROM driver_cash_exceptions WHERE "bookingId"=$2 AND "driverId"=$1 AND "confirmedAt" IS NULL))`,
    [driverId, bookingId],
  );
  const row = rows[0];
  if (!row?.active) return null;
  const n = Number(row.occurrence);
  const notice: CashExceptionNotice = {
    requiresDriverAcknowledgment: true,
    message: isDriver
      ? row.alreadyCounted
        ? 'Exception déjà comptée pour ce trajet : aucune nouvelle pénalité. La commission de ce paiement reste due.'
        : n === 1
          ? 'Premier trajet en cash exceptionnel : avertissement, sans pénalité. Commission due. Prochain trajet non éligible : 3 000 FC.'
          : `Cash non éligible : une pénalité de 3 000 FC pour tout le trajet, hors commission. Prélevée après la commission sur votre solde, puis ses prochains crédits pour le reste. Aucun supplément passager.${n >= 4 ? ' Nouvelles courses bloquées, puis désactivation après la fin des courses en cours.' : ' Désactivation après la troisième récidive.'}`
      : 'Cash exceptionnel : prévenez le conducteur avant de payer. Il devra confirmer l’encaissement.',
    ...(isDriver
      ? {
          occurrence: n,
          penaltyAmount: row.alreadyCounted || n === 1 ? 0 : 3000,
          alreadyCountedForTrip: Boolean(row.alreadyCounted),
          suspensionAfterRide: n >= 4,
        }
      : {}),
  };
  return { pending: row.pending, notice };
}
