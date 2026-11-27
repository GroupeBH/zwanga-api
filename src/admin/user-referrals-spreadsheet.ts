import { UserRole, UserStatus } from '../users/entities/user.entity';
import { buildSpreadsheet } from './spreadsheet';

export interface AdminUserReferralItem {
  id: string;
  user: {
    id: string;
    firstName: string;
    lastName: string;
    phone?: string | null;
    email?: string | null;
    role: UserRole;
    status: UserStatus;
    isDriver: boolean;
    isActive: boolean;
    createdAt: Date;
  };
  referredAt: Date | null;
}
const roles: Record<UserRole, string> = {
  driver: 'Conducteur',
  passenger: 'Passager',
  admin: 'Administrateur',
  super_admin: 'Super administrateur',
  marketer: 'Marketeur',
};
const statuses: Record<UserStatus, string> = {
  active: 'Actif',
  inactive: 'Désactivé',
  suspended: 'Suspendu',
  pending_kyc: 'En vérification',
};
export const buildUserReferralsSpreadsheet = (items: AdminUserReferralItem[]) =>
  buildSpreadsheet(
    'Filleuls',
    [
      'ID utilisateur',
      'Prénom',
      'Nom',
      'Téléphone',
      'Email',
      'Rôle du compte',
      'Statut',
      'Compte actif',
      'Création du compte (UTC)',
      'Attribution du parrainage (UTC)',
    ],
    items.map(({ user, referredAt }) => [
      user.id,
      user.firstName,
      user.lastName,
      user.phone,
      user.email,
      roles[user.role] ?? user.role,
      statuses[user.status] ?? user.status,
      user.isActive,
      user.createdAt,
      referredAt,
    ]),
  );
