import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../users/entities/user.entity';
import { PaymentsService } from '../payments/payments.service';
import { PaymentStatus } from '../payments/entities/payment-transaction.entity';

@Injectable()
export class AdminPaymentReconciliationService {
  private readonly logger = new Logger(AdminPaymentReconciliationService.name);

  constructor(
    private readonly payments: PaymentsService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async reconcile(actorId: string, paymentId: string) {
    const actor = await this.users.findOne({
      where: { id: actorId, isActive: true },
    });
    if (
      !actor ||
      actor.role !== UserRole.SUPER_ADMIN ||
      actor.passwordChangeRequired
    ) {
      throw new ForbiddenException(
        'Action réservée au super administrateur actif.',
      );
    }
    // The worker treats a missing payment as a finished job; HTTP must return 404.
    const before = await this.payments.findTransactionById(paymentId);
    this.logger.log(
      `ADMIN_PAYMENT_RECONCILE actor=${actorId} payment=${paymentId} previousStatus=${before.status}`,
    );
    try {
      // Checks the original order and applies its existing idempotent settlement.
      // Never initiate, retry, cancel or mark a payment paid without provider proof.
      const completed = await this.payments.reconcilePayment(paymentId);
      const payment = await this.payments.findTransactionById(paymentId);
      const code = completed
        ? 'RECONCILED'
        : !payment.orderNumber
          ? 'MISSING_PROVIDER_ORDER'
          : 'UNRESOLVED';
      const message = !completed
        ? code === 'MISSING_PROVIDER_ORDER'
          ? 'Vérification impossible sans référence de commande du prestataire. Aucun nouvel envoi effectué ; le statut reste à confirmer.'
          : 'Le rapprochement n’a pas confirmé de résultat définitif. Actualisez ou vérifiez le dossier auprès du prestataire. Aucun nouvel envoi effectué.'
        : payment.status === PaymentStatus.SUCCEEDED
          ? 'Paiement confirmé et rapprochement appliqué. Aucun nouvel envoi effectué.'
          : 'Rapprochement appliqué : paiement échoué ou annulé. Aucun nouvel envoi effectué.';
      this.logger.log(
        `ADMIN_PAYMENT_RECONCILE_RESULT actor=${actorId} payment=${paymentId} status=${payment.status} code=${code}`,
      );
      // Explicit projection: no phone, credentials or raw provider responses.
      return {
        paymentId,
        status: payment.status,
        paidAt: payment.paidAt,
        updatedAt: payment.updatedAt,
        completed,
        code,
        message,
      };
    } catch (error) {
      this.logger.warn(
        `ADMIN_PAYMENT_RECONCILE_FAILED actor=${actorId} payment=${paymentId}`,
      );
      throw error;
    }
  }
}
