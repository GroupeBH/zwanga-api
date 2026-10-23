import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { PaymentMethod } from '../../payments/entities/payment-transaction.entity';

export class RecoverTopUpDto {
  @IsUUID('4') idempotencyKey: string;
  @Type(() => Number) @IsNumber() @Min(1) amount: number;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
}
