import { Transform } from 'class-transformer';
import {
  Equals,
  IsNumber,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AdminDirectPayoutDto {
  @ApiProperty({
    format: 'uuid',
    description: 'UUID v4 conservé pour toutes les tentatives du même ordre.',
  })
  @IsUUID('4')
  idempotencyKey: string;

  @ApiProperty({ example: '+243891234567' })
  @IsString()
  @Matches(/^\+?243[89]\d{8}$/)
  phone: string;

  @ApiProperty({ minimum: 1, maximum: 99999999.99 })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(99999999.99)
  amount: number;

  @ApiProperty({ enum: ['CDF'] })
  @Equals('CDF')
  currency: 'CDF';

  @ApiProperty({ minLength: 5, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(5, 500)
  reason: string;

  @ApiProperty({
    enum: [true],
    description:
      'Confirme un décaissement des fonds Zwanga, distinct de tout retrait utilisateur.',
  })
  @Equals(true)
  confirmed: true;
}
