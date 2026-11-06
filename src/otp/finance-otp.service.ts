import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { isUUID, validateSync } from 'class-validator';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { AdminDirectPayoutDto } from '../admin/dto/admin-direct-payout.dto';
import { RetryPayoutDto } from '../payments/dto/retry-payout.dto';
import { normalizePayoutPhone } from '../payments/payout-policy';
import { OtpService } from './otp.service';

export type FinanceAction =
  'direct_payout' | 'driver_payout_retry' | 'referral_withdrawal_retry';

/** Explicit field list: stable intent binding, no OTP/provider secrets stored. */
export function financeIntent(
  action: FinanceAction,
  payload: unknown,
  targetId?: string,
): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new BadRequestException('Opération financière invalide.');
  if (
    ![
      'direct_payout',
      'driver_payout_retry',
      'referral_withdrawal_retry',
    ].includes(action)
  )
    throw new BadRequestException('Action financière invalide.');
  const dto =
    action === 'direct_payout'
      ? plainToInstance(AdminDirectPayoutDto, payload)
      : plainToInstance(RetryPayoutDto, payload);
  if (validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).length)
    throw new BadRequestException(
      'Paramètres de confirmation financière invalides.',
    );
  let fields: unknown[];
  if (dto instanceof AdminDirectPayoutDto) {
    if (targetId)
      throw new BadRequestException('Identifiant de cible inattendu.');
    fields = [
      dto.idempotencyKey.toLowerCase(),
      normalizePayoutPhone(dto.phone),
      dto.amount,
      dto.currency,
      dto.reason,
      dto.confirmed,
    ];
  } else {
    if (!isUUID(targetId)) throw new BadRequestException('Retrait invalide.');
    fields = [
      targetId!.toLowerCase(),
      dto.reason,
      dto.expectedReference,
      dto.evidenceReference,
      dto.confirmedNotPaid,
      dto.confirmedNotReceived,
    ];
  }
  return createHash('sha256')
    .update(JSON.stringify([action, ...fields]))
    .digest('hex');
}

@Injectable()
export class FinanceOtpService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly otp: OtpService,
  ) {}

  private async actor(actorId: string) {
    if (!actorId)
      throw new ForbiddenException('Authentification administrateur requise.');
    const actor = await this.users.findOne({
      where: { id: actorId },
      select: [
        'id',
        'role',
        'status',
        'isActive',
        'passwordChangeRequired',
        'phone',
      ],
    });
    if (
      !actor ||
      actor.role !== UserRole.SUPER_ADMIN ||
      !actor.isActive ||
      actor.passwordChangeRequired ||
      actor.status !== UserStatus.ACTIVE
    )
      throw new ForbiddenException(
        'Confirmation réservée au super administrateur actif.',
      );
    if (!actor.phone)
      throw new ForbiddenException(
        'Numéro de sécurité administrateur manquant.',
      );
    return actor;
  }
  private binding(
    actorId: string,
    action: FinanceAction,
    payload: unknown,
    targetId?: string,
  ) {
    return createHash('sha256')
      .update(
        JSON.stringify([actorId, financeIntent(action, payload, targetId)]),
      )
      .digest('hex');
  }
  async send(
    actorId: string,
    action: FinanceAction,
    payload: unknown,
    targetId?: string,
  ) {
    const actor = await this.actor(actorId);
    const binding = this.binding(actorId, action, payload, targetId);
    const result = await this.otp.sendOtp(
      actor.phone,
      'admin_finance',
      binding,
    );
    return { ...result, maskedPhone: `***${actor.phone.slice(-3)}` };
  }
  async verify(
    actorId: string,
    action: FinanceAction,
    payload: Record<string, unknown>,
    targetId?: string,
  ) {
    const actor = await this.actor(actorId);
    const binding = this.binding(actorId, action, payload, targetId);
    if (typeof payload.otpCode !== 'string' || !/^\d{6}$/.test(payload.otpCode))
      throw new ForbiddenException({
        code: 'FINANCE_OTP_REQUIRED',
        message:
          'Confirmez cette opération avec le code SMS envoyé au super administrateur.',
      });
    const result = await this.otp.verifyOtp(
      actor.phone,
      payload.otpCode,
      'admin_finance',
      binding,
    );
    if (!result.valid)
      throw new ForbiddenException({
        code: 'FINANCE_OTP_INVALID',
        message:
          'Code incorrect, expiré ou lié à une autre opération. Demandez un nouveau code.',
      });
  }
}
