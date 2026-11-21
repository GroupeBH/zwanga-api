import { CreditMutationDto } from '../shared/credit.dto';
import {
  IsOptional,
  IsUUID,
  IsISO8601,
  IsIn,
  IsString,
  Length,
} from 'class-validator';

export class DeliverCreditProductDto extends CreditMutationDto {
  @IsOptional() @IsUUID() stockId?: string;
  @IsUUID() proofId: string;
  @IsOptional() @IsISO8601({ strict: true }) issuedAt?: string;
  @IsOptional() @IsISO8601({ strict: true }) expiresAt?: string;
}

export class UpdateCreditDeliveryDto extends CreditMutationDto {
  @IsIn(['processing', 'rejected', 'returned']) status:
    'processing' | 'rejected' | 'returned';
  @IsString() @Length(10, 1000) reason: string;
}
