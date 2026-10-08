import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { User, UserStatus } from './entities/user.entity';

/** Pending KYC is still a usable account, not an available phone number. */
export function accountReservesPhone(
  user: Pick<User, 'isActive' | 'status'> | null | undefined,
): boolean {
  return Boolean(
    user &&
    user.isActive !== false &&
    user.status !== UserStatus.INACTIVE &&
    user.status !== UserStatus.SUSPENDED,
  );
}

/**
 * Keep the global unique phone constraint. An unavailable account relinquishes
 * only its phone when the new account is actually persisted, never on OTP send.
 * Its UUID, financial history, KYC and restrictions are not inherited or reset.
 */
export async function saveRegistrationWithPhone(
  users: Repository<User>,
  newUser: User,
): Promise<User> {
  return users.manager.transaction(async (manager) => {
    const phone = newUser.phone.trim();
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`zwanga:registration-phone:${phone}`],
    );
    const repository = manager.getRepository(User);
    const previous = await repository.findOne({
      where: { phone },
      lock: { mode: 'pessimistic_write' },
    });
    if (accountReservesPhone(previous)) {
      throw new BadRequestException('Ce numéro de téléphone est déjà utilisé');
    }
    if (previous) {
      await repository.update(previous.id, {
        phone: () => 'NULL',
        isPhoneVerified: false,
        isActive: false,
        accessToken: null,
        refreshToken: null,
        fcmToken: null,
      });
    }
    newUser.phone = phone;
    return repository.save(newUser);
  });
}
