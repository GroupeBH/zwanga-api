import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { validateSync } from 'class-validator';
import { Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { PaymentsService } from '../payments/payments.service';
import {
  PaymentProvider,
  PaymentPurpose,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { adminPayoutReference } from '../payments/admin-payout-claim';
import { normalizePayoutPhone } from '../payments/payout-policy';
import { AdminDirectPayoutDto } from './dto/admin-direct-payout.dto';

@Injectable()
export class AdminDirectPayoutService {
  constructor(
    private readonly payments: PaymentsService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(PaymentTransaction)
    private readonly transactions: Repository<PaymentTransaction>,
  ) {}

  private async authorize(actorId: string) {
    const actor = await this.users.findOneBy({ id: actorId });
    if (
      !actor ||
      actor.role !== UserRole.SUPER_ADMIN ||
      !actor.isActive ||
      actor.passwordChangeRequired ||
      [UserStatus.SUSPENDED, UserStatus.INACTIVE].includes(actor.status)
    )
      throw new ForbiddenException(
        'Virement réservé au super administrateur actif.',
      );
  }

  async create(actorId: string, dto: AdminDirectPayoutDto) {
    await this.authorize(actorId);
    if (
      validateSync(Object.assign(new AdminDirectPayoutDto(), dto), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }).length
    )
      throw new BadRequestException(
        'Montant, numéro, motif, confirmation et identifiant de virement requis.',
      );
    try {
      const payment = await this.payments.initiatePayout({
        userId: actorId,
        purpose: PaymentPurpose.ADMIN_PAYOUT,
        relatedEntityType: 'admin_direct_payout',
        relatedEntityId: dto.idempotencyKey.toLowerCase(),
        phone: normalizePayoutPhone(dto.phone),
        amount: dto.amount,
        currency: dto.currency,
        description: dto.reason.trim(),
        preferredProvider: PaymentProvider.FLEXPAY,
      });
      return this.project(payment);
    } catch (error) {
      // A rejected or uncertain send can already be recorded. Preserve its ID for follow-up.
      // Never hide validation/conflict/authorization errors by returning a different order.
      if (
        error instanceof ForbiddenException ||
        (error as { status?: number })?.status === 409
      )
        throw error;
      const payment = await this.find(actorId, dto.idempotencyKey);
      if (
        !payment ||
        Number(payment.amount) !== dto.amount ||
        payment.phone !== normalizePayoutPhone(dto.phone) ||
        payment.currency !== dto.currency ||
        payment.description !== dto.reason.trim()
      )
        throw error;
      return this.project(payment);
    }
  }

  async get(actorId: string, key: string) {
    await this.authorize(actorId);
    const payment = await this.find(actorId, key);
    if (!payment)
      throw new NotFoundException('Aucun virement enregistré pour cet ordre.');
    return this.project(payment);
  }

  private find(actorId: string, key: string) {
    return this.transactions.findOneBy({
      reference: adminPayoutReference(actorId, key),
      userId: actorId,
      purpose: PaymentPurpose.ADMIN_PAYOUT,
      relatedEntityType: 'admin_direct_payout',
    });
  }

  private project(payment: PaymentTransaction) {
    return {
      id: payment.id,
      idempotencyKey: payment.relatedEntityId,
      actorId: payment.userId,
      amount: Number(payment.amount),
      currency: payment.currency,
      phone: payment.phone,
      reason: payment.description,
      status: payment.status,
      reference: payment.reference,
      orderNumber: payment.orderNumber,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
      paidAt: payment.paidAt,
    };
  }
}
