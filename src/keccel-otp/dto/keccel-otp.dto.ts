import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, Min, Max } from 'class-validator';

/**
 * DTO for sending OTP
 */
export class SendOtpDto {
  @ApiProperty({
    description: 'Phone number to send OTP to (E.164 format recommended)',
    example: '+243900000000',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiPropertyOptional({
    description: 'Custom message template. Use %OTP% placeholder for the OTP code',
    example: 'Votre code de vérification est : %OTP%',
    default: 'Votre code est : %OTP%',
  })
  @IsString()
  @IsOptional()
  message?: string;

  @ApiPropertyOptional({
    description: 'OTP code length',
    example: 6,
    minimum: 4,
    maximum: 8,
    default: 6,
  })
  @IsNumber()
  @IsOptional()
  @Min(4)
  @Max(8)
  length?: number;

  @ApiPropertyOptional({
    description: 'OTP lifetime in seconds',
    example: 300,
    minimum: 60,
    default: 300,
  })
  @IsNumber()
  @IsOptional()
  @Min(60)
  lifetime?: number;
}

/**
 * DTO for verifying OTP
 */
export class VerifyOtpDto {
  @ApiProperty({
    description: 'Phone number that received the OTP',
    example: '+243900000000',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({
    description: 'OTP code to verify',
    example: '123456',
  })
  @IsString()
  @IsNotEmpty()
  otp: string;
}

/**
 * Response from Keccel OTP Generate API
 */
export interface KeccelOtpGenerateResponse {
  status: 'SENT' | 'ERROR';
  description: string;
}

/**
 * Response from Keccel OTP Validate API
 */
export interface KeccelOtpValidateResponse {
  success: 'True' | 'False';
  statusOTP: 'VALID' | 'INVALID';
}

/**
 * Standardized response for sendOtp method
 */
export interface SendOtpResponse {
  success: boolean;
  message: string;
  status?: string;
}

/**
 * Standardized response for verifyOtp method
 */
export interface VerifyOtpResponse {
  valid: boolean;
  status: string;
}

