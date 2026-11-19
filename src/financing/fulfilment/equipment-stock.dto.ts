import { CreditMutationDto } from '../shared/credit.dto';
import { IsUUID, IsString, Matches, Length, IsOptional } from 'class-validator';

export class RegisterEquipmentStockDto extends CreditMutationDto {
  @IsUUID() productId: string;
  @IsString() @Matches(/^[A-Z0-9-]{3,100}$/) inventoryReference: string;
  @IsString() @Length(3, 100) serial: string;
  @IsOptional() @IsString() @Matches(/^\d{15}$/) imei?: string;
}
