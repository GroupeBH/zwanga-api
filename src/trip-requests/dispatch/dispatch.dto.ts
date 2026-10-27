import { IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsUUID, Max, Min, ValidateIf } from 'class-validator';

export class DriverPositionDto {
  @IsNumber() @Min(-90) @Max(90) latitude: number;
  @IsNumber() @Min(-180) @Max(180) longitude: number;
  @IsNumber() @Min(0) @Max(250) accuracy: number;
  @IsISO8601() recordedAt: string;
}

export class DriverPresenceDto {
  @IsOptional() @IsUUID() leaseId?: string;
  @IsBoolean() available: boolean;
  @ValidateIf((v: DriverPresenceDto) => v.available) @IsUUID() vehicleId?: string;
  @ValidateIf((v: DriverPresenceDto) => v.available) @IsInt() @Min(1) @Max(20) seats?: number;
  @ValidateIf((v: DriverPresenceDto) => v.available) @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @ValidateIf((v: DriverPresenceDto) => v.available) @IsNumber() @Min(-180) @Max(180) longitude?: number;
}

export class RequestDispatchEventDto {
  @IsIn(['declined']) type: 'declined';
  @IsUUID() offerId: string;
}

export class DispatchResponseDto {
  @IsIn(['accept', 'decline']) decision: 'accept' | 'decline';
}

export class NotificationCapabilityDto {
  @IsInt() @IsIn([1, 2, 3, 4, 5, 6]) version: number;
}

export class NotificationReceiptDto {
  @IsOptional() @IsIn(['received', 'displayed']) stage?: 'received' | 'displayed';
  @IsOptional() @IsISO8601() observedAt?: string;
  @IsOptional() @IsIn(['native', 'javascript']) source?: 'native' | 'javascript';
  @IsOptional() @IsIn(['NATIVE_CARD_FAILED', 'NATIVE_CARD_PENDING', 'NATIVE_FALLBACK_FAILED']) failureCode?: string;
}
