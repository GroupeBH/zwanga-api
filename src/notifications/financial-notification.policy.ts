import {
  WalletLedgerEntry,
  WalletLedgerEntryType as WalletType,
} from '../wallet/entities/wallet-ledger-entry.entity';
import {
  ReferralBalanceBucket,
  ReferralLedgerEntry,
  ReferralLedgerEntryType as ReferralType,
} from '../referrals/entities/referral-ledger-entry.entity';
import {
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import {
  displayAmount,
  TransactionalNotification,
} from './transactional-notification';

export function walletMovementNotification(
  entry: WalletLedgerEntry,
): TransactionalNotification | null {
  // Withdrawal lifecycle owns these notifications (one alert, not one per ledger + state).
  if (
    [WalletType.WITHDRAWAL, WalletType.WITHDRAWAL_REFUND].includes(entry.type)
  )
    return null;
  const amount = displayAmount(entry.amount, entry.currency);
  const balance = displayAmount(entry.balanceAfter, entry.currency);
  const copy: Partial<Record<WalletType, [string, string]>> = {
    [WalletType.TOP_UP]: [
      'Recharge réussie',
      `${amount} ont été ajoutés à votre portefeuille.`,
    ],
    [WalletType.BOOKING_PAYMENT]: [
      'Trajet payé en jetons',
      `${amount} ont été débités pour votre trajet.`,
    ],
    [WalletType.BOOKING_REFUND]: [
      'Remboursement du trajet',
      `${amount} ont été recrédités sur votre portefeuille.`,
    ],
    [WalletType.BOOKING_FARE_ADJUSTMENT]: [
      'Tarif du trajet ajusté',
      `${amount} ont été recrédités après ajustement du tarif.`,
    ],
    [WalletType.SUBSCRIPTION_PAYMENT]: [
      'Paiement de l’abonnement confirmé',
      `${amount} ont été débités pour votre abonnement.`,
    ],
    [WalletType.SUBSCRIPTION_REWARD]: [
      'Bonus d’abonnement reçu',
      `${amount} ont été ajoutés à votre portefeuille.`,
    ],
    [WalletType.LOYALTY_REWARD]: [
      'Bonus de fidélité reçu',
      `${amount} ont été ajoutés à votre portefeuille.`,
    ],
    [WalletType.TRANSFER_OUT]: [
      'Transfert de jetons effectué',
      `${amount} ont été envoyés depuis votre portefeuille.`,
    ],
    [WalletType.TRANSFER_IN]: [
      'Jetons reçus',
      `Vous avez reçu ${amount} sur votre portefeuille.`,
    ],
    [WalletType.ADMIN_ADJUSTMENT]: [
      'Solde de jetons ajusté',
      `Un administrateur a ${Number(entry.amount) > 0 ? 'ajouté' : 'retiré'} ${amount} ${Number(entry.amount) > 0 ? 'à' : 'de'} votre portefeuille.`,
    ],
  };
  const [title, body] = copy[entry.type] ?? [
    'Mouvement de portefeuille confirmé',
    `${amount} ont été ${Number(entry.amount) > 0 ? 'crédités' : 'débités'}.`,
  ];
  return {
    eventKey: `wallet:${entry.id}`,
    userId: entry.userId,
    title,
    body: `${body} Solde après opération : ${balance}.`,
    data: {
      type: `wallet_${entry.type}`,
      ledgerEntryId: entry.id,
      amount: Number(entry.amount),
      currency: entry.currency,
      balanceAfter: Number(entry.balanceAfter),
      relatedEntityType: entry.relatedEntityType,
      relatedEntityId: entry.relatedEntityId,
      paymentTransactionId: entry.paymentTransactionId,
    },
  };
}

export function referralMovementNotification(
  entry: ReferralLedgerEntry,
): TransactionalNotification | null {
  // A bucket transfer writes two rows. Only its user-facing credit is notified.
  if (entry.type.startsWith('withdrawal_')) return null;
  if (
    entry.type === ReferralType.REWARD_RELEASED &&
    entry.bucket !== ReferralBalanceBucket.AVAILABLE
  )
    return null;
  const amount = displayAmount(entry.amountTokens, 'PTS');
  const copy: Partial<Record<ReferralType, [string, string]>> = {
    [ReferralType.ATTRIBUTION_BONUS]: [
      'Bonus de parrainage reçu',
      `${amount} ont été ajoutés à votre solde de parrainage après une nouvelle inscription.`,
    ],
    [ReferralType.REWARD_PENDING]: [
      'Commission de parrainage enregistrée',
      `${amount} sont en attente dans votre compte de parrainage. Ils ne sont pas encore disponibles au retrait.`,
    ],
    [ReferralType.REWARD_RELEASED]: [
      'Commission de parrainage disponible',
      `${amount} sont maintenant disponibles dans votre compte de parrainage.`,
    ],
    [ReferralType.REWARD_REVERSED]: [
      'Commission de parrainage annulée',
      `Une commission de ${amount} a été annulée. Consultez votre historique de parrainage.`,
    ],
  };
  const message = copy[entry.type];
  if (!message) return null;
  return {
    eventKey: `referral-ledger:${entry.id}`,
    userId: entry.userId,
    title: message[0],
    body: message[1],
    data: {
      type: `referral_${entry.type}`,
      ledgerEntryId: entry.id,
      amount: Number(entry.amountTokens),
      currency: 'PTS',
      bucket: entry.bucket,
      balanceAfter: Number(entry.balanceAfter),
      rewardId: entry.rewardId,
    },
  };
}

export function paymentNotification(
  payment: PaymentTransaction,
): TransactionalNotification | null {
  if (
    !payment.userId ||
    ![
      PaymentStatus.SUCCEEDED,
      PaymentStatus.FAILED,
      PaymentStatus.CANCELLED,
    ].includes(payment.status)
  )
    return null;
  // Payouts are notified only once their owning business balance has been settled.
  if (
    [
      PaymentPurpose.DRIVER_PAYOUT,
      PaymentPurpose.REFERRAL_PAYOUT,
      PaymentPurpose.WALLET_PAYOUT,
    ].includes(payment.purpose as PaymentPurpose)
  )
    return null;
  // A successful top-up is notified only when tokens are actually credited.
  if (
    payment.purpose === String(PaymentPurpose.WALLET_TOP_UP) &&
    payment.status === PaymentStatus.SUCCEEDED
  )
    return null;
  const succeeded = payment.status === PaymentStatus.SUCCEEDED;
  const amount = displayAmount(payment.amount, payment.currency);
  return {
    eventKey: `payment:${payment.id}:${payment.status}`,
    userId: payment.userId,
    title: succeeded ? 'Paiement confirmé' : 'Paiement non abouti',
    body: succeeded
      ? `Votre paiement de ${amount} a été confirmé.`
      : `Votre paiement de ${amount} ${payment.status === PaymentStatus.CANCELLED ? 'a été annulé' : 'n’a pas abouti'}. Consultez son statut dans l’application.`,
    data: {
      type: `payment_${payment.status}`,
      paymentTransactionId: payment.id,
      purpose: payment.purpose,
      status: payment.status,
      amount: Number(payment.amount),
      currency: payment.currency,
      relatedEntityType: payment.relatedEntityType,
      relatedEntityId: payment.relatedEntityId,
    },
  };
}

export interface WithdrawalNotificationInput {
  id: string;
  userId: string;
  kind: 'driver' | 'wallet' | 'referral';
  status: string;
  amount: number;
  currency: string;
  review?: boolean;
}

export function withdrawalNotification(
  input: WithdrawalNotificationInput,
): TransactionalNotification | null {
  // pending/initiated are the same user-visible request, not two separate alerts.
  const status = input.review
    ? 'review'
    : input.status === 'initiated'
      ? 'pending'
      : input.status;
  const amount = displayAmount(input.amount, input.currency);
  const copy: Record<string, [string, string]> = {
    pending: [
      'Retrait demandé',
      `Votre demande de retrait de ${amount} a été enregistrée. Le versement n’est pas encore confirmé.`,
    ],
    succeeded: [
      'Retrait effectué',
      `Le versement de ${amount} a été confirmé.`,
    ],
    failed: [
      'Retrait non abouti',
      `Votre retrait de ${amount} a échoué. Consultez le solde et le statut actualisés dans l’application.`,
    ],
    cancelled: [
      'Retrait annulé',
      `Votre retrait de ${amount} a été annulé dans Zwanga. Consultez votre solde actualisé.`,
    ],
    review: [
      'Retrait en vérification',
      `Votre retrait de ${amount} nécessite une vérification. Consultez son statut avant toute nouvelle tentative.`,
    ],
  };
  const message = copy[status];
  if (!message) return null;
  return {
    eventKey: `${input.kind}-withdrawal:${input.id}:${status}`,
    userId: input.userId,
    title: message[0],
    body: message[1],
    data: {
      type: `${input.kind}_withdrawal_${status}`,
      withdrawalId: input.id,
      status,
      amount: Number(input.amount),
      currency: input.currency,
    },
  };
}
