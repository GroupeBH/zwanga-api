import { CreditMutationDto } from '../shared/credit.dto';
import {
  Equals,
  IsBoolean,
  IsString,
  Matches,
  IsISO8601,
  IsOptional,
} from 'class-validator';

export class AcceptCreditContractDto extends CreditMutationDto {
  @Equals(true) @IsBoolean() consent: boolean;
  @IsString() @Matches(/^[a-f0-9]{64}$/) termsHash: string;
  @IsOptional() @IsISO8601({ strict: true }) mandateUntil?: string;
}
