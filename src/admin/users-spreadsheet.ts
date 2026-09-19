import {
  UserGender,
  UserRole,
  UserStatus,
} from '../users/entities/user.entity';
import { buildSpreadsheet } from './spreadsheet';

export type UsersSpreadsheetRow = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  gender?: UserGender | null;
  role: UserRole | string;
  isDriver: boolean;
  isQualifiedDriver?: boolean;
  hasApprovedKyc?: boolean;
  hasActiveVehicle?: boolean;
  status: UserStatus | string;
  isActive: boolean;
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  lastLoginAt?: Date | string | null;
  createdAt?: Date | string | null;
};

const HEADERS = [
  'ID',
  'Prénom',
  'Nom',
  'Email',
  'Téléphone',
  'Sexe',
  'Profil déclaré',
  'Conducteur',
  'KYC validé',
  'Véhicule actif',
  'Statut',
  'Compte actif',
  'Email vérifié',
  'Téléphone vérifié',
  'Dernière connexion',
  "Date d'inscription",
] as const;

const ROLE_LABELS: Record<string, string> = {
  [UserRole.DRIVER]: 'Conducteur',
  [UserRole.PASSENGER]: 'Passager',
  [UserRole.ADMIN]: 'Admin',
  [UserRole.SUPER_ADMIN]: 'Super admin',
};

const STATUS_LABELS: Record<string, string> = {
  [UserStatus.ACTIVE]: 'Actif',
  [UserStatus.INACTIVE]: 'Inactif',
  [UserStatus.SUSPENDED]: 'Suspendu',
  [UserStatus.PENDING_KYC]: 'En vérification',
};

const GENDER_LABELS: Record<string, string> = {
  [UserGender.MALE]: 'Homme',
  [UserGender.FEMALE]: 'Femme',
  [UserGender.OTHER]: 'Autre',
  [UserGender.PREFER_NOT_TO_SAY]: 'Non renseigné',
};

const yesNo = (value: boolean): string => (value ? 'Oui' : 'Non');

export const usersSpreadsheetFilename = (
  segment: 'driver' | 'passenger' | 'verified_passenger' | undefined,
  now = new Date(),
): string => {
  const suffix =
    segment === 'driver'
      ? 'conducteurs'
      : segment === 'passenger'
        ? 'passagers'
        : segment === 'verified_passenger'
          ? 'passagers-kyc'
          : 'tous';

  return `utilisateurs-zwanga-${suffix}-${now.toISOString().slice(0, 10)}.xls`;
};

export const buildUsersSpreadsheet = (
  users: UsersSpreadsheetRow[],
): Buffer =>
  buildSpreadsheet(
    'Utilisateurs',
    HEADERS,
    users.map((user) => [
      user.id,
      user.firstName ?? '',
      user.lastName ?? '',
      user.email ?? '',
      user.phone ?? '',
      user.gender ? (GENDER_LABELS[user.gender] ?? user.gender) : '',
      ROLE_LABELS[user.role] ?? user.role,
      yesNo(Boolean(user.isQualifiedDriver)),
      yesNo(Boolean(user.hasApprovedKyc)),
      yesNo(Boolean(user.hasActiveVehicle)),
      STATUS_LABELS[user.status] ?? user.status,
      yesNo(Boolean(user.isActive)),
      yesNo(Boolean(user.isEmailVerified)),
      yesNo(Boolean(user.isPhoneVerified)),
      user.lastLoginAt,
      user.createdAt,
    ]),
  );
