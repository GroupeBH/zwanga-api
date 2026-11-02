import { DriverPayout } from '../driver-settlements/entities/driver-payout.entity';
import { ReferralWithdrawal } from '../referrals/entities/referral-withdrawal.entity';
import { PayoutRetryKind } from './entities/payout-retry.entity';
import { PaymentProvider, PaymentPurpose, PaymentStatus, PaymentTransaction } from './entities/payment-transaction.entity';
import { PAYOUT_RELEASE_GRACE_MS } from './payout-recovery-actions';

/** UI capability only. The write path still authorizes, reconciles, locks and
 * revalidates balances and the entire retry chain before any provider send. */
export function payoutRetryAvailability(
  kind: PayoutRetryKind,
  source: DriverPayout | ReferralWithdrawal,
  payment: PaymentTransaction | null | undefined,
  hasReplacement: boolean,
  now = Date.now(),
) {
  const blocked = (code: string, message: string, availableAt: string | null = null) => ({
    canAdminRetry: false,
    adminRetry: { code, message, availableAt },
  });
  if (hasReplacement) return blocked('ALREADY_RETRIED', 'Une relance existe déjà. Ouvrez le versement de remplacement pour le suivre.');
  if (source.status === 'succeeded' || payment?.status === PaymentStatus.SUCCEEDED)
    return blocked('ALREADY_PAID', 'Ce versement est confirmé comme payé. Aucun nouvel envoi autorisé.');
  if ('recoveryBlocked' in source && source.recoveryBlocked)
    return blocked('RECOVERY_BLOCKED', 'Un incident financier doit être rapproché avant toute relance.');
  if (payment && payment.provider !== PaymentProvider.FLEXPAY)
    return blocked('UNSUPPORTED_PROVIDER', 'La relance de ce prestataire n’est pas prise en charge par ce parcours.');
  const owner = 'driverId' in source ? source.driverId : source.userId;
  if ((source.paymentTransactionId && source.paymentTransactionId !== payment?.id) ||
      !Number.isFinite(Number(source.amount)) || Number(source.amount) <= 0 || !source.phone ||
      (payment && (payment.userId !== owner || payment.relatedEntityType !== kind ||
        payment.relatedEntityId !== source.id ||
        payment.purpose !== (kind === 'driver_payout' ? PaymentPurpose.DRIVER_PAYOUT : PaymentPurpose.REFERRAL_PAYOUT) ||
        Number(payment.amount) !== Number(source.amount) || payment.currency !== source.currency ||
        payment.phone?.replace(/^\+/, '') !== source.phone.replace(/^\+/, ''))))
    return blocked('PAYMENT_MISMATCH', 'Le retrait et sa transaction ne concordent pas. Rapprochez le dossier avant de relancer.');
  if (['pending', 'initiated'].includes(source.status)) {
    const readyAt = new Date(source.requestedAt ?? source.createdAt).getTime() + PAYOUT_RELEASE_GRACE_MS;
    if (!Number.isFinite(readyAt)) return blocked('INVALID_STATE', 'La date du retrait doit être vérifiée.');
    if (now < readyAt) return blocked('SAFETY_DELAY', 'Délai de sécurité de 15 minutes : actualisez le dossier à l’heure indiquée.', new Date(readyAt).toISOString());
  } else if (!['failed', 'cancelled'].includes(source.status)) {
    return blocked('INVALID_STATE', 'Ce statut ne permet pas une relance. Actualisez le dossier.');
  }
  return {
    canAdminRetry: true,
    adminRetry: {
      code: 'AVAILABLE', availableAt: null,
      message: 'Relance possible après confirmation de non-réception et preuve de non-exécution définitive du prestataire. Montant et numéro conservés ; solde revérifié lors de la relance.',
    },
  };
}
