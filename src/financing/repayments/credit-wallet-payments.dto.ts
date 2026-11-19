import { CreditMutationDto } from '../shared/credit.dto';
import { IsIn, IsString, Matches } from 'class-validator';

export class CreditWalletPaymentDto extends CreditMutationDto {
  @IsIn(['deposit', 'repayment']) purpose: 'deposit' | 'repayment';
  @IsString() @Matches(/^[1-9][0-9]{0,12}$/) amountMinor: string;
}
