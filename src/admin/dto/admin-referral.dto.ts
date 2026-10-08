import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class AdminAttachReferrerDto {
  @ApiProperty({ description: 'Utilisateur à rattacher comme parrain.' })
  @IsUUID()
  referrerUserId: string;

  @ApiProperty({ minLength: 10, maxLength: 300 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(10)
  @MaxLength(300)
  reason: string;
}
