import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RideRingCheckDto {
  @ApiProperty({ description: 'Short-lived invitation capability supplied by the server; not an account token.' })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  token: string;
}
