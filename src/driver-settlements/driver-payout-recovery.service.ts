import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { PaymentsService } from '../payments/payments.service';
import {
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { User } from '../users/entities/user.entity';
import { DriverSettlementsService } from './driver-settlements.service';
import {
  DriverPayout,
  DriverPayoutStatus,
} from './entities/driver-payout.entity';
import {
  DriverPayoutEvent,
  DriverPayoutEventAction,
} from './entities/driver-payout-event.entity';
import {
  ClosePayoutIncidentDto,
  PayoutRecoveryListDto,
  ResolveDriverPayoutDto,
} from './dto/driver-payout-recovery.dto';
import {
  PAYOUT_RECOVERY_GRACE_MS,
  payoutReviewDelay,
} from './driver-payout-recovery.policy';

@Injectable()
export class DriverPayoutRecoveryService {
  constructor(
    private readonly source: DataSource,
    private readonly payments: PaymentsService,
    private readonly settlements: DriverSettlementsService,
    private readonly config: ConfigService,
  ) {}

  async list(query: PayoutRecoveryListDto) {
    const cutoff = new Date(
      Date.now() -
        payoutReviewDelay(
          this.config.get('DRIVER_PAYOUT_REVIEW_AFTER_MINUTES'),
        ) *
          60_000,
    );
    const [rows, total] = await this.source
      .getRepository(DriverPayout)
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.paymentTransaction', 'payment')
      .where(
        `p."recoveryBlocked" = true OR (p.status IN (:...pending) AND
        (p."reviewRequestedAt" IS NOT NULL OR p."createdAt" <= :cutoff OR payment."orderNumber" IS NULL))`,
        { pending: ['pending', 'initiated'], cutoff },
      )
      .orderBy('p.createdAt', 'ASC')
      .addOrderBy('p.id', 'ASC')
      .take(query.limit)
      .skip(query.offset)
      .getManyAndCount();
    return {
      data: rows.map((p) => this.settlements.formatPayoutForClient(p)),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  async detail(id: string) {
    const payout = await this.find(id);
    const payment = await this.findPayment(payout);
    const events = await this.source.getRepository(DriverPayoutEvent).find({
      where: { payoutId: id },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: 100,
    });
    return {
      payout: this.settlements.formatPayoutForClient(payout, payment),
      events,
    };
  }

  async requestReview(driverId: string, id: string, reason: string) {
    const expected = await this.find(id, driverId);
    await this.source.transaction(async (manager) => {
      const payout = await this.lock(manager, expected);
      if (
        ![DriverPayoutStatus.PENDING, DriverPayoutStatus.INITIATED].includes(
          payout.status,
        ) ||
        payout.reviewRequestedAt
      )
        return;
      payout.reviewRequestedAt = new Date();
      await manager.save(DriverPayout, payout);
      await this.event(manager, payout, driverId, 'review_requested', reason);
    });
    const payout = await this.find(id, driverId);
    return this.settlements.formatPayoutForClient(
      payout,
      await this.findPayment(payout),
    );
  }

  /** Owner-authorized lookup by internal ID also works when FlexPay gave no order number. */
  async refresh(
    id: string,
    driverId?: string,
    recoveredOrder?: string,
    actorId?: string,
  ) {
    const payout = await this.find(id, driverId);
    let payment = await this.findPayment(payout);
    if (payment) {
      if (payment.provider === PaymentProvider.FLEXPAY) {
        payment = await this.payments.reconcileFlexPayDriverPayout(
          payment.id,
          recoveredOrder,
        );
      } else if (recoveredOrder) {
        throw new BadRequestException(
          'Récupération de référence réservée à FlexPay',
        );
      } else if (payment.orderNumber) {
        payment = await this.payments.checkPaymentStatus(
          payment.orderNumber,
          payout.driverId,
        );
      }
      await this.settlements.applyPaymentToPayout(payment, payout.driverId);
    } else if (recoveredOrder) {
      throw new ConflictException('Aucune transaction Zwanga à rapprocher');
    }
    if (actorId) {
      await this.source.transaction((manager) =>
        this.event(
          manager,
          payout,
          actorId,
          'reconciled',
          'Vérification auprès du prestataire, sans nouvel envoi',
          recoveredOrder ?? null,
          { paymentId: payment?.id ?? null, status: payment?.status ?? null },
        ),
      );
    }
    const current = await this.find(id, driverId);
    return this.settlements.formatPayoutForClient(current, payment);
  }

  async resolveNotPaid(
    actorId: string,
    id: string,
    dto: ResolveDriverPayoutDto,
  ) {
    if (
      dto.confirmedNotPaid !== true ||
      !dto.evidenceReference?.trim() ||
      !dto.reason?.trim()
    ) {
      throw new BadRequestException(
        'La confirmation définitive de non-paiement et sa preuve sont obligatoires',
      );
    }
    const expected = await this.find(id);
    const known = await this.findPayment(expected);
    if (
      known?.provider !== undefined &&
      known.provider !== PaymentProvider.FLEXPAY
    ) {
      throw new BadRequestException(
        'Résolution manuelle réservée aux retraits FlexPay',
      );
    }
    // Network calls must finish before obtaining locks. An outage does not replace
    // the mandatory out-of-band, definitive confirmation supplied by operations.
    if (known?.orderNumber) {
      try {
        await this.refresh(id);
      } catch (error) {
        if (!(error instanceof BadGatewayException)) throw error;
      }
    }
    const result = await this.source.transaction(async (manager) => {
      const payout = await this.lock(manager, expected);
      const payment = await this.lockPayment(manager, payout);
      if (dto.expectedReference !== (payment?.reference ?? payout.id)) {
        throw new ConflictException(
          'La référence du retrait a changé : rechargez le dossier',
        );
      }
      if (
        payout.status === DriverPayoutStatus.SUCCEEDED ||
        payment?.status === PaymentStatus.SUCCEEDED ||
        payout.recoveryBlocked
      ) {
        throw new ConflictException(
          'Un versement confirmé ne peut pas être annulé',
        );
      }
      if (
        payout.fundsReleasedAt ||
        [DriverPayoutStatus.CANCELLED, DriverPayoutStatus.FAILED].includes(
          payout.status,
        )
      )
        return payout;
      const age =
        Date.now() - new Date(payout.requestedAt ?? payout.createdAt).getTime();
      if (!Number.isFinite(age) || age < PAYOUT_RECOVERY_GRACE_MS) {
        throw new ConflictException(
          'Le versement est trop récent : attendez la fin du traitement initial',
        );
      }
      if (
        payment &&
        (payment.provider !== PaymentProvider.FLEXPAY ||
          payment.purpose !== String(PaymentPurpose.DRIVER_PAYOUT) ||
          Number(payment.amount) !== Number(payout.amount) ||
          payment.currency !== payout.currency)
      ) {
        throw new ConflictException(
          'La transaction ne correspond pas au retrait',
        );
      }
      payout.paymentTransactionId = payment?.id ?? payout.paymentTransactionId;
      payout.status = DriverPayoutStatus.CANCELLED;
      payout.fundsReleasedAt = new Date();
      payout.processedAt = payout.fundsReleasedAt;
      payout.reviewRequestedAt ??= payout.fundsReleasedAt;
      payout.reviewResolvedAt = payout.fundsReleasedAt;
      payout.failureReason =
        'Non-exécution confirmée par le prestataire ; montant libéré par l’assistance';
      // Keep the provider transaction unchanged. Local release is not evidence
      // from its API; late confirmations must still be processed and audited.
      await manager.save(DriverPayout, payout);
      await this.event(
        manager,
        payout,
        actorId,
        'released_confirmed_not_paid',
        dto.reason,
        dto.evidenceReference,
        {
          paymentId: payment?.id ?? null,
          reference: dto.expectedReference,
          amount: Number(payout.amount),
          currency: payout.currency,
          previousPaymentStatus: payment?.status ?? null,
        },
      );
      return payout;
    });
    return this.settlements.formatPayoutForClient(
      result,
      await this.findPayment(result),
    );
  }

  async closeLateSuccessIncident(
    actorId: string,
    id: string,
    dto: ClosePayoutIncidentDto,
  ) {
    const expected = await this.find(id);
    const result = await this.source.transaction(async (manager) => {
      const payout = await this.lock(manager, expected);
      if (!payout.recoveryBlocked) return payout;
      if (payout.status !== DriverPayoutStatus.SUCCEEDED)
        throw new ConflictException('Dossier incohérent');
      // Acknowledgement only: never credit the driver or remove the successful payout.
      // Further withdrawals still use earnings minus ALL successful/reserved payouts.
      payout.recoveryBlocked = false;
      payout.reviewResolvedAt = new Date();
      await manager.save(DriverPayout, payout);
      await this.event(
        manager,
        payout,
        actorId,
        'late_success_review_closed',
        dto.reason,
        dto.evidenceReference,
      );
      return payout;
    });
    return this.settlements.formatPayoutForClient(
      result,
      await this.findPayment(result),
    );
  }

  private async find(id: string, driverId?: string) {
    const payout = await this.source
      .getRepository(DriverPayout)
      .findOne({ where: { id, ...(driverId ? { driverId } : {}) } });
    if (!payout) throw new NotFoundException('Retrait introuvable');
    return payout;
  }

  private findPayment(payout: DriverPayout) {
    return this.payments.findLatestTransactionForRelatedEntity(
      'driver_payout',
      payout.id,
      payout.driverId,
    );
  }

  private async lock(manager: EntityManager, expected: DriverPayout) {
    await manager.findOne(User, {
      where: { id: expected.driverId },
      select: { id: true },
      lock: { mode: 'pessimistic_write' },
    });
    const payout = await manager.findOne(DriverPayout, {
      where: { id: expected.id, driverId: expected.driverId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!payout) throw new NotFoundException('Retrait introuvable');
    return payout;
  }

  private async lockPayment(manager: EntityManager, payout: DriverPayout) {
    const payment = await manager.findOne(PaymentTransaction, {
      where: {
        relatedEntityType: 'driver_payout',
        relatedEntityId: payout.id,
        userId: payout.driverId,
      },
      lock: { mode: 'pessimistic_write' },
      order: { createdAt: 'DESC' },
    });
    if (
      payout.paymentTransactionId &&
      payment?.id !== payout.paymentTransactionId
    ) {
      throw new ConflictException(
        'Transaction liée incohérente : rapprochement requis',
      );
    }
    return payment;
  }

  private async event(
    manager: EntityManager,
    payout: DriverPayout,
    actorId: string,
    action: DriverPayoutEventAction,
    reason: string,
    evidenceReference: string | null = null,
    details: Record<string, unknown> | null = null,
  ) {
    await manager.save(
      DriverPayoutEvent,
      manager.create(DriverPayoutEvent, {
        payoutId: payout.id,
        actorId,
        action,
        reason,
        evidenceReference,
        details,
      }),
    );
  }
}
