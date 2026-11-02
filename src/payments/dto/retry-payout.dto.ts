import { Equals } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ResolvePayoutNotPaidDto } from './resolve-payout-not-paid.dto';

export class RetryPayoutDto extends ResolvePayoutNotPaidDto {
  @ApiProperty({
    enum: [true],
    description:
      'Le bénéficiaire confirme la non-réception. La preuve définitive de non-exécution du prestataire reste obligatoire.',
  })
  @Equals(true)
  confirmedNotReceived: true;
}
