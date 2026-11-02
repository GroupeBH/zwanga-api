import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { isUUID } from 'class-validator';
import { Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import {
  PaymentProvider,
  PaymentPurpose,
  PaymentTransaction,
} from './entities/payment-transaction.entity';

export const adminPayoutReference = (actorId: string, key: string) =>
  `ADM${createHash('sha256').update(`${actorId}:${key.toLowerCase()}`).digest('hex').slice(0, 22)}`;

/** Persist BEFORE HTTP. Replays, including after a crash, may only read this attempt. */
export async function claimAdminPayoutPayment(
  repository: Repository<PaymentTransaction>,
  draft: PaymentTransaction,
) {
  if (
    draft.purpose !== String(PaymentPurpose.ADMIN_PAYOUT) ||
    draft.relatedEntityType !== 'admin_direct_payout' ||
    !isUUID(draft.relatedEntityId ?? '', '4') ||
    !draft.userId ||
    draft.provider !== PaymentProvider.FLEXPAY ||
    draft.reference !==
      adminPayoutReference(draft.userId, draft.relatedEntityId!) ||
    draft.currency !== 'CDF' ||
    !Number.isFinite(draft.amount) ||
    draft.amount < 1 ||
    draft.amount > 99999999.99 ||
    Math.abs(draft.amount * 100 - Math.round(draft.amount * 100)) > 0.000001 ||
    !/^\+243[89]\d{8}$/.test(draft.phone ?? '') ||
    !draft.description ||
    draft.description.trim().length < 5 ||
    draft.description.length > 500
  )
    throw new BadRequestException('Ordre de virement administratif invalide.');
  return repository.manager.transaction(async (manager) => {
    const actor = await manager.findOne(User, {
      where: { id: draft.userId! },
      lock: { mode: 'pessimistic_write' },
    });
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
    const existing = await manager.findOneBy(PaymentTransaction, {
      reference: draft.reference,
    });
    if (existing) {
      if (
        existing.userId !== draft.userId ||
        existing.purpose !== draft.purpose ||
        existing.relatedEntityId !== draft.relatedEntityId ||
        existing.relatedEntityType !== draft.relatedEntityType ||
        Number(existing.amount) !== draft.amount ||
        existing.currency !== draft.currency ||
        existing.phone !== draft.phone ||
        existing.description !== draft.description
      )
        throw new ConflictException(
          'Cet identifiant désigne déjà un autre ordre. Consultez le virement existant.',
        );
      return { payment: existing, created: false };
    }
    return {
      payment: await manager.save(PaymentTransaction, draft),
      created: true,
    };
  });
}
