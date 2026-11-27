import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CreditMutationDto } from '../shared/credit.dto';

export const RECOVERY_KINDS = [
  'call',
  'sms',
  'whatsapp',
  'visit',
  'office_meeting',
  'written_notice',
  'promise',
  'other',
] as const;
export const RECOVERY_OUTCOMES = [
  'reached',
  'unreachable',
  'promise_to_pay',
  'refused',
  'paid',
  'disputed',
  'other',
] as const;

export class RecoveryActionDto extends CreditMutationDto {
  @IsUUID(undefined, { message: 'mutationId doit être un UUID valide.' })
  declare mutationId: string;
  @IsIn(RECOVERY_KINDS, { message: 'Type d’action de recouvrement invalide.' })
  kind: (typeof RECOVERY_KINDS)[number];
  @IsIn(RECOVERY_OUTCOMES, { message: 'Résultat de recouvrement invalide.' })
  outcome: (typeof RECOVERY_OUTCOMES)[number];
  @IsString({ message: 'La note doit être un texte.' })
  @Length(3, 1000, { message: 'La note doit contenir de 3 à 1000 caractères.' })
  note: string;
  @IsOptional()
  @IsISO8601(
    { strict: true },
    { message: 'Date ISO 8601 valide requise pour la promesse.' },
  )
  promisedAt?: string;
  // A promise is not a wallet transfer: cents need not be multiples of ten.
  @IsOptional()
  @IsString({
    message: 'Le montant doit être une chaîne de chiffres en centimes CDF.',
  })
  @Matches(/^[0-9]{1,13}$/, {
    message: 'Le montant doit contenir uniquement de 1 à 13 chiffres.',
  })
  promisedAmountMinor?: string;
}

export class RecoveryPageDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit doit être un entier.' })
  @Min(1, { message: 'limit doit être supérieur ou égal à 1.' })
  @Max(100, { message: 'limit ne doit pas dépasser 100.' })
  limit = 25;
  @IsOptional()
  @IsString({ message: 'Le curseur doit être un texte.' })
  @MaxLength(2048, { message: 'Curseur trop long.' })
  after?: string;
}

export class DebtorsPageDto extends RecoveryPageDto {
  limit = 50;
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'minDays doit être un entier.' })
  @Min(0, { message: 'minDays doit être positif ou nul.' })
  @Max(365000, { message: 'minDays ne doit pas dépasser 365000.' })
  minDays?: number;
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'maxDays doit être un entier.' })
  @Min(0, { message: 'maxDays doit être positif ou nul.' })
  @Max(365000, { message: 'maxDays ne doit pas dépasser 365000.' })
  maxDays?: number;
}
