import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import {
  DataSource,
  EntitySubscriberInterface,
  InsertEvent,
  UpdateEvent,
} from 'typeorm';
import { WalletLedgerEntry, WalletLedgerEntryType } from '../wallet/entities/wallet-ledger-entry.entity';
import { User } from '../users/entities/user.entity';
import { ReferralLedgerEntry } from '../referrals/entities/referral-ledger-entry.entity';
import { DriverPayout } from '../driver-settlements/entities/driver-payout.entity';
import { WalletWithdrawal } from '../wallet/entities/wallet-withdrawal.entity';
import { ReferralWithdrawal } from '../referrals/entities/referral-withdrawal.entity';
import { PaymentTransaction } from '../payments/entities/payment-transaction.entity';
import {
  PawaPayRefund,
  PawaPayRefundStatus,
} from '../payments/entities/pawapay-refund.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import {
  ProServiceCase,
  ProServiceLedger,
} from '../pro-services/pro-service.entities';
import {
  enqueueTransactionalNotification,
  displayAmount,
  TransactionalNotification,
} from './transactional-notification';
import {
  paymentNotification,
  referralMovementNotification,
  walletMovementNotification,
  withdrawalNotification,
} from './financial-notification.policy';

const INSERT_TARGETS = new Set<unknown>([
  Booking,
  WalletLedgerEntry,
  ReferralLedgerEntry,
  DriverPayout,
  WalletWithdrawal,
  ReferralWithdrawal,
  PaymentTransaction,
  PawaPayRefund,
  KycDocument,
  ProServiceLedger,
]);
const UPDATE_TARGETS = new Set<unknown>([
  PaymentTransaction,
  DriverPayout,
  WalletWithdrawal,
  ReferralWithdrawal,
  PawaPayRefund,
  KycDocument,
]);

/**
 * Persist an outbox entry in the SAME transaction as the business write.
 * The dispatcher cannot observe it until commit; rollback removes both.
 * State-changing writes must use save, which provides a complete previous row.
 * Raw SQL commands such as cash receipts explicitly enqueue instead.
 */
@Injectable()
export class TransactionalNotificationsSubscriber
  implements EntitySubscriberInterface, OnModuleDestroy
{
  constructor(private readonly dataSource: DataSource) {
    dataSource.subscribers.push(this);
  }

  onModuleDestroy() {
    const index = this.dataSource.subscribers.indexOf(this);
    if (index >= 0) this.dataSource.subscribers.splice(index, 1);
  }

  beforeInsert(event: InsertEvent<unknown>): void {
    if (
      INSERT_TARGETS.has(event.metadata.target) &&
      !event.queryRunner.isTransactionActive
    ) {
      throw new Error(
        'Financial/KYC inserts require a transaction; use save() or a transactional manager',
      );
    }
  }

  beforeUpdate(event: UpdateEvent<unknown>): void {
    if (!UPDATE_TARGETS.has(event.metadata.target)) return;
    const next = event.entity as
      { status?: string; recoveryBlocked?: boolean } | undefined;
    if (
      next &&
      (next.status !== undefined || next.recoveryBlocked !== undefined) &&
      (!event.databaseEntity || !event.queryRunner.isTransactionActive)
    ) {
      // Reject before the SQL write, not after an auto-committed partial update.
      throw new Error(
        'Financial/KYC state transitions require transactional save() with the previous entity',
      );
    }
  }

  async afterInsert(event: InsertEvent<unknown>): Promise<void> {
    await this.enqueue(event, true);
  }

  async afterUpdate(event: UpdateEvent<unknown>): Promise<void> {
    // Ledger rows are immutable; updates to technical fields do not create events.
    if (!UPDATE_TARGETS.has(event.metadata.target)) return;
    const next = event.entity as
      | {
          status?: string;
          recoveryBlocked?: boolean;
          reviewedBy?: string | null;
        }
      | undefined;
    const previous = event.databaseEntity as typeof next;
    if (
      !next ||
      (next.status === undefined && next.recoveryBlocked === undefined)
    )
      return;
    if (
      previous &&
      next.status === previous.status &&
      next.recoveryBlocked === previous.recoveryBlocked &&
      next.reviewedBy === previous.reviewedBy
    )
      return;
    await this.enqueue(event, false);
  }

  private async enqueue(
    event: InsertEvent<unknown> | UpdateEvent<unknown>,
    inserted: boolean,
  ) {
    const target = event.metadata.target;
    if (!INSERT_TARGETS.has(target)) return;
    const entity = {
      ...('databaseEntity' in event ? (event.databaseEntity as object) : {}),
      ...(event.entity as object),
    } as { id?: string };
    if (!entity.id)
      throw new Error(
        `Transactional notification requires the ${event.metadata.tableName} primary key; use save() for business state transitions`,
      );
    let notification: TransactionalNotification | null = null;
    if (target === Booking && inserted) {
      const booking = entity as Booking;
      if (booking.status === BookingStatus.PENDING) {
        const trip = await event.manager.findOneBy(Trip, { id: booking.tripId });
        // Assigned requests already have their own dispatch invitation.
        if (trip && !trip.tripRequestId) notification = {
          eventKey: `booking:${booking.id}:new`, userId: trip.driverId,
          title: 'Nouvelle réservation',
          body: 'Un passager souhaite réserver votre trajet. Accepter ou refuser ?',
          data: { type: 'new_booking', bookingId: booking.id, tripId: trip.id,
            driverId: trip.driverId, role: 'driver' },
        };
      }
    }
    if (target === WalletLedgerEntry && inserted) {
      const entry = entity as WalletLedgerEntry;
      const recipient = entry.type === WalletLedgerEntryType.LOYALTY_REWARD &&
        entry.relatedEntityType === 'welcome_bonus'
        ? await event.manager.findOne(User, {
            where: { id: entry.userId },
            select: { role: true },
          })
        : null;
      notification = walletMovementNotification(entry, recipient?.role);
    }
    if (target === ReferralLedgerEntry && inserted)
      notification = referralMovementNotification(
        entity as ReferralLedgerEntry,
      );
    if (target === PaymentTransaction)
      notification = paymentNotification(entity as PaymentTransaction);
    if (target === DriverPayout) {
      const payout = entity as DriverPayout;
      notification = withdrawalNotification({
        ...payout,
        kind: 'driver',
        userId: payout.driverId,
        review: payout.recoveryBlocked,
      });
    }
    if (target === WalletWithdrawal || target === ReferralWithdrawal) {
      const payout = entity as WalletWithdrawal | ReferralWithdrawal;
      notification = withdrawalNotification({
        ...payout,
        kind: target === WalletWithdrawal ? 'wallet' : 'referral',
      });
    }
    if (target === KycDocument) {
      const kyc = entity as KycDocument;
      const previous =
        'databaseEntity' in event
          ? (event.databaseEntity as KycDocument | undefined)
          : undefined;
      const manualReviewChanged =
        inserted ||
        previous?.reviewedBy !== kyc.reviewedBy ||
        String(previous?.reviewedAt ?? '') !== String(kyc.reviewedAt ?? '');
      const statusChanged = inserted || previous?.status !== kyc.status;
      // An approval is an identity event, regardless of its source. Polling or
      // an admin confirming the same Didit approval is not a second approval.
      // Preserve notifications for explicit manual rejections as well.
      if (
        kyc.userId &&
        ((kyc.status === KycStatus.APPROVED && statusChanged) ||
          (kyc.status === KycStatus.REJECTED &&
            kyc.reviewedBy && manualReviewChanged))
      ) {
        const approved = kyc.status === KycStatus.APPROVED;
        notification = {
          eventKey: `kyc:${kyc.id}:${kyc.status}:${kyc.reviewedAt ? new Date(kyc.reviewedAt).toISOString() : 'manual'}`,
          userId: kyc.userId,
          title: approved
            ? 'Identité vérifiée'
            : 'Vérification d’identité à reprendre',
          body: approved
            ? 'Votre identité a été vérifiée avec succès. Consultez votre profil pour voir les fonctionnalités disponibles.'
            : 'Votre vérification d’identité n’a pas été validée. Consultez votre profil pour connaître la suite à donner.',
          data: {
            type: `kyc_${kyc.status}`,
            kycId: kyc.id,
            status: kyc.status,
            reviewedAt: kyc.reviewedAt
              ? new Date(kyc.reviewedAt).toISOString()
              : null,
          },
        };
      }
    }
    if (target === PawaPayRefund) {
      const refund = entity as PawaPayRefund;
      if (
        [PawaPayRefundStatus.COMPLETED, PawaPayRefundStatus.FAILED].includes(
          refund.status,
        )
      ) {
        const payment = await event.manager.findOneBy(PaymentTransaction, {
          id: refund.paymentTransactionId,
        });
        if (payment?.userId) {
          const completed = refund.status === PawaPayRefundStatus.COMPLETED;
          notification = {
            eventKey: `refund:${refund.id}:${refund.status}`,
            userId: payment.userId,
            title: completed
              ? 'Remboursement confirmé'
              : 'Remboursement non abouti',
            body: completed
              ? `Votre remboursement de ${displayAmount(refund.amount, refund.currency)} a été confirmé.`
              : 'Votre remboursement n’a pas abouti. Contactez l’assistance pour vérifier son statut.',
            data: {
              type: `payment_refund_${refund.status}`,
              refundId: refund.id,
              paymentTransactionId: payment.id,
              amount: Number(refund.amount),
              currency: refund.currency,
              status: refund.status,
            },
          };
        }
      }
    }
    if (target === ProServiceLedger && inserted) {
      const entry = entity as ProServiceLedger;
      const serviceCase = await event.manager.findOneBy(ProServiceCase, {
        id: entry.caseId,
      });
      if (serviceCase?.ownerId) {
        const label = {
          deposit: 'Votre acompte',
          funding: 'Votre financement',
          repayment: 'Votre remboursement',
        }[entry.kind];
        notification = {
          eventKey: `pro-ledger:${entry.id}`,
          userId: serviceCase.ownerId,
          title: 'Opération de financement enregistrée',
          body: `${label} de ${displayAmount(entry.amountMinor / 100, entry.currency)} a été enregistré pour votre dossier.`,
          data: {
            type: 'pro_service_financial_operation',
            caseId: entry.caseId,
            ledgerEntryId: entry.id,
            kind: entry.kind,
            amountMinor: entry.amountMinor,
            currency: entry.currency,
          },
        };
      }
    }
    if (notification)
      await enqueueTransactionalNotification(event.manager, notification);
  }
}
