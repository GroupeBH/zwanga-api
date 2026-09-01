import * as bcrypt from 'bcrypt';
import { type FindOneOptions, Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import {
  isAdminRole,
  isSelfServiceUserRole,
  type AdminUserRole,
} from '../users/user-role.policy';

export type ExistingAdminAccountStrategy = 'reject' | 'promote_self_service';

export interface AdminProvisioningInput {
  phone: string;
  firstName: string;
  lastName: string;
  password?: string;
  pin?: string;
  role?: AdminUserRole;
  passwordChangeRequired?: boolean;
  isPhoneVerified?: boolean;
  existingAccountStrategy?: ExistingAdminAccountStrategy;
  lockExistingAccount?: boolean;
}

interface NormalizedAdminProvisioningInput {
  phone: string;
  firstName: string;
  lastName: string;
  password: string;
  role: AdminUserRole;
  passwordChangeRequired: boolean;
  isPhoneVerified: boolean;
}

const ADMIN_PASSWORD_MIN_LENGTH = 8;
const ADMIN_PASSWORD_MAX_LENGTH = 128;
const PHONE_PATTERN = /^\+?\d{8,15}$/;

function requireName(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 100) {
    throw new Error(`${label} doit contenir entre 1 et 100 caractères`);
  }

  return normalized;
}

export function normalizeAdminProvisioningInput(
  input: AdminProvisioningInput,
): NormalizedAdminProvisioningInput {
  const phone = input.phone.replace(/[\s().-]/g, '');
  if (!PHONE_PATTERN.test(phone)) {
    throw new Error(
      'Le numéro de téléphone doit contenir entre 8 et 15 chiffres, avec un + optionnel',
    );
  }

  const password = input.password ?? input.pin;
  if (
    !password ||
    password.length < ADMIN_PASSWORD_MIN_LENGTH ||
    password.length > ADMIN_PASSWORD_MAX_LENGTH
  ) {
    throw new Error(
      `Le mot de passe doit contenir entre ${ADMIN_PASSWORD_MIN_LENGTH} et ${ADMIN_PASSWORD_MAX_LENGTH} caractères`,
    );
  }

  const role = input.role ?? UserRole.ADMIN;
  if (!isAdminRole(role)) {
    throw new Error('Le role doit etre admin ou super_admin');
  }

  return {
    phone,
    firstName: requireName(input.firstName, 'Le prénom'),
    lastName: requireName(input.lastName, 'Le nom'),
    password,
    role,
    passwordChangeRequired: input.passwordChangeRequired ?? false,
    isPhoneVerified: input.isPhoneVerified ?? false,
  };
}

export async function provisionAdminAccount(
  userRepository: Repository<User>,
  input: AdminProvisioningInput,
): Promise<User> {
  const normalized = normalizeAdminProvisioningInput(input);
  const password = await bcrypt.hash(normalized.password, 12);
  const findOptions: FindOneOptions<User> = {
    where: { phone: normalized.phone },
  };

  if (input.lockExistingAccount) {
    findOptions.lock = { mode: 'pessimistic_write' };
  }

  const existingUser = await userRepository.findOne({
    ...findOptions,
  });

  if (existingUser) {
    if (input.existingAccountStrategy !== 'promote_self_service') {
      throw new Error(
        'Un compte utilise déjà ce numéro. Aucun rôle existant n’a été modifié.',
      );
    }

    if (!isSelfServiceUserRole(existingUser.role)) {
      throw new Error(
        'Ce numéro appartient déjà à un compte back-office. Aucun rôle existant n’a été modifié.',
      );
    }

    existingUser.password = password;
    existingUser.firstName = normalized.firstName;
    existingUser.lastName = normalized.lastName;
    existingUser.role = normalized.role;
    existingUser.status = UserStatus.ACTIVE;
    existingUser.isActive = true;
    existingUser.isDriver = false;
    existingUser.isPhoneVerified =
      normalized.isPhoneVerified || existingUser.isPhoneVerified;
    existingUser.passwordChangeRequired = normalized.passwordChangeRequired;
    existingUser.accessToken = null;
    existingUser.refreshToken = null;
    existingUser.fcmToken = null;

    return userRepository.save(existingUser);
  }

  const admin = userRepository.create({
    phone: normalized.phone,
    password,
    firstName: normalized.firstName,
    lastName: normalized.lastName,
    gender: null,
    role: normalized.role,
    status: UserStatus.ACTIVE,
    isActive: true,
    isDriver: false,
    isPhoneVerified: normalized.isPhoneVerified,
    isEmailVerified: false,
    passwordChangeRequired: normalized.passwordChangeRequired,
  });

  return userRepository.save(admin);
}
