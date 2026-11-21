import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class AdminPhoneVerificationDto {
  @ApiProperty({ description: 'Numéro affiché dans la fiche lors du contrôle.' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(9)
  @MaxLength(40)
  phone: string;

  @ApiProperty({ minLength: 10, maxLength: 300 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(10)
  @MaxLength(300)
  reason: string;
}
