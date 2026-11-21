import { CreditMutationDto } from '../shared/credit.dto';
import {
  IsInt,
  Min,
  Max,
  IsIn,
  IsString,
  Length,
  Equals,
  IsBoolean,
} from 'class-validator';

export class ProposeCreditScheduleDto extends CreditMutationDto {
  @IsInt() @Min(1) @Max(120) installments: number;
  @IsIn(['week', 'month']) period: 'week' | 'month';
  @IsString() @Length(10, 1000) reason: string;
}

export class ConsentCreditScheduleDto extends CreditMutationDto {
  @Equals(true) @IsBoolean() consent: boolean;
}
