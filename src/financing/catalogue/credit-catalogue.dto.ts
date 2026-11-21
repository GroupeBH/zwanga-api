import {
  IsIn,
  IsString,
  Matches,
  Length,
  IsUUID,
  IsArray,
  ArrayUnique,
  ArrayMaxSize,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsBoolean,
  IsUrl,
} from 'class-validator';

export class CreateCreditProductDto {
  @IsOptional() @IsUUID() mutationId?: string;
  @IsIn(['document', 'phone', 'equipment', 'vehicle']) kind:
    'document' | 'phone' | 'equipment' | 'vehicle';
  @IsString() @Matches(/^[a-z0-9-]{3,80}$/) code: string;
  @IsString() @Length(3, 160) name: string;
  @IsString() @Length(3, 4000) description: string;
  @IsUUID() supplierId: string;
  @IsUUID() sellerId: string;
  @IsUUID() creditorId: string;
  @IsUUID() policyId: string;
  @IsIn(['ZWANGA_DIRECT', 'PARTNER_DIRECT']) financingModel:
    'ZWANGA_DIRECT' | 'PARTNER_DIRECT';
  @IsIn(['CDF']) currency: 'CDF';
  @IsString() @Matches(/^[1-9][0-9]{0,12}$/) priceMinor: string;
  @IsString() @Matches(/^(0|[1-9][0-9]{0,12})$/) feeMinor: string;
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(3)
  @IsIn(['car', 'motorcycle_2_wheels', 'motorcycle_3_wheels'], { each: true })
  vehicleTypes: string[];
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @Matches(/^[a-z0-9-]{1,60}$/, { each: true })
  requiredEvidence: string[];
  @IsOptional() @IsInt() @Min(1) @Max(3650) validityDays?: number;
  @IsInt() @Min(0) @Max(365) processingDays: number;
  @IsOptional() @IsString() @Length(1, 100) brand?: string;
  @IsOptional() @IsString() @Length(1, 100) model?: string;
  @IsOptional() @IsString() @Length(0, 2000) specifications?: string;
  @IsOptional() @IsString() @Length(0, 2000) warranty?: string;
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @Length(1, 2000)
  imageUrl?: string;
}

export class SetCreditProductEnabledDto {
  @IsBoolean() enabled: boolean;
}
