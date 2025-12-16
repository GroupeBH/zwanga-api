import {
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, catchError, throwError, retryWhen, concatMap, timer } from 'rxjs';
import { AxiosError } from 'axios';
import {
  SendOtpDto,
  VerifyOtpDto,
  KeccelOtpGenerateResponse,
  KeccelOtpValidateResponse,
  SendOtpResponse,
  VerifyOtpResponse,
} from './dto/keccel-otp.dto';

@Injectable()
export class KeccelOtpService {
  private readonly logger = new Logger(KeccelOtpService.name);
  private readonly token: string;
  private readonly from: string;
  private readonly generateUrl: string;
  private readonly validateUrl: string;
  private readonly defaultMessage = 'Votre code est : %OTP%';
  private readonly defaultLength = 6;
  private readonly defaultLifetime = 300; // 5 minutes

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    const token = this.configService.get<string>('KECCEL_TOKEN');
    if (!token) {
      throw new Error('KECCEL_TOKEN is not defined in environment variables');
    } 
    this.token = token;

    const from = this.configService.get<string>('KECCEL_FROM');
    if (!from) {
      throw new Error('KECCEL_FROM is not defined in environment variables');
    }
    this.from = from;

    this.generateUrl =
      this.configService.get<string>('KECCEL_OTP_URL_GENERATE') ||
      'https://api.keccel.com/otp/generate.asp';
    this.validateUrl =
      this.configService.get<string>('KECCEL_OTP_URL_VALIDATE') ||
      'https://api.keccel.com/otp/validate.asp';

    if (!this.token) {
      this.logger.warn(
        'KECCEL_TOKEN is not configured. OTP service may not work properly.',
      );
    }
  }

  /**
   * Send OTP to a phone number
   * @param phone Phone number (E.164 format recommended)
   * @param message Optional custom message template with %OTP% placeholder
   * @param length Optional OTP code length (4-8, default: 6)
   * @param lifetime Optional OTP lifetime in seconds (minimum: 60, default: 300)
   * @returns Promise<SendOtpResponse>
   * @throws HttpException if the API call fails or status is not 'SENT'
   */
  async sendOtp(
    phone: string,
    message?: string,
    length?: number,
    lifetime?: number,
  ): Promise<SendOtpResponse> {
    this.logger.log(`Sending OTP to phone: ${phone}`);

    if (!phone || !phone.trim()) {
      throw new BadRequestException('Phone number is required');
    }
    this.logger.debug(`Token: ${this.token}`);
    this.logger.debug(`From: ${this.from}`);
    this.logger.debug(`Phone: ${phone.trim()}`);
    this.logger.debug(`Message: ${message || this.defaultMessage}`);
    this.logger.debug(`Length: ${length}`);
    this.logger.debug(`Lifetime: ${lifetime}`);

    const params = new URLSearchParams({
      token: this.token,
      from: this.from,
      to: phone.trim(),
      message: message || this.defaultMessage,
    });

    if (length !== undefined) {
      if (length < 4 || length > 8) {
        throw new BadRequestException('OTP length must be between 4 and 8');
      }
      params.append('length', length.toString());
    }

    if (lifetime !== undefined) {
      if (lifetime < 60) {
        throw new BadRequestException('OTP lifetime must be at least 60 seconds');
      }
      params.append('lifetime', lifetime.toString());
    }

    const url = `${this.generateUrl}?${params.toString()}`;

    try {
      this.logger.debug(`Calling Keccel OTP Generate API: ${this.generateUrl}`);
      this.logger.debug(`Request parameters: from=${this.from}, to=${phone.trim()}`);

      const response = await firstValueFrom(
        this.httpService.get<KeccelOtpGenerateResponse>(url).pipe(
          retryWhen((errors) =>
            errors.pipe(
              concatMap((error, index: number) => {
                if (index >= 1) {
                  return throwError(() => error);
                }
                return timer(1000);
              }),
            ),
          ),
          catchError((error: AxiosError) => {
            this.logger.error(
              `Keccel OTP Generate API error: ${error.message}`,
              error.stack,
            );
            return throwError(
              () =>
                new HttpException(
                  `Failed to send OTP: ${error.message}`,
                  error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
                ),
            );
          }),
        ),
      );

      const data = response.data;

      this.logger.debug(`Keccel OTP Generate API response: ${JSON.stringify(data)}`);

      if (data.status === 'SENT') {
        this.logger.log(`OTP sent successfully to ${phone}`);
        return {
          success: true,
          message: data.description || 'OTP sent successfully',
          status: data.status,
        };
      } else {
        this.logger.error(
          `Keccel OTP Generate API returned error status: ${data.description}`,
        );
        this.logger.error(
          `API Error details - Status: ${data.status}, Description: ${data.description}, From parameter: ${this.from}`,
        );
        
        // Provide more helpful error message for common issues
        let errorMessage = data.description || 'Failed to send OTP';
        if (data.description?.includes('FROM') || data.description?.includes('from')) {
          errorMessage = `Configuration error: Invalid FROM parameter. Please check KECCEL_FROM environment variable. Current value: ${this.from}`;
        }
        
        throw new HttpException(
          errorMessage,
          HttpStatus.BAD_REQUEST,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(
        `Unexpected error while sending OTP: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        'An unexpected error occurred while sending OTP',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Verify OTP code
   * @param phone Phone number that received the OTP
   * @param otp OTP code to verify
   * @returns Promise<VerifyOtpResponse>
   * @throws HttpException only if HTTP or API error occurs, not if OTP is invalid
   */
  async verifyOtp(phone: string, otp: string): Promise<VerifyOtpResponse> {
    this.logger.log(`Verifying OTP for phone: ${phone}`);

    if (!phone || !phone.trim()) {
      throw new BadRequestException('Phone number is required');
    }

    if (!otp || !otp.trim()) {
      throw new BadRequestException('OTP code is required');
    }

    const params = new URLSearchParams({
      token: this.token,
      from: this.from,
      to: phone.trim(),
      otp: otp.trim(),
    });

    const url = `${this.validateUrl}?${params.toString()}`;

    try {
      this.logger.debug(`Calling Keccel OTP Validate API: ${this.validateUrl}`);

      const response = await firstValueFrom(
        this.httpService.get<KeccelOtpValidateResponse>(url).pipe(
          retryWhen((errors) =>
            errors.pipe(
              concatMap((error, index) => {
                if (index >= 1) {
                  return throwError(() => error);
                }
                return timer(1000);
              }),
            ),
          ),
          catchError((error: AxiosError) => {
            this.logger.error(
              `Keccel OTP Validate API error: ${error.message}`,
              error.stack,
            );
            return throwError(
              () =>
                new HttpException(
                  `Failed to verify OTP: ${error.message}`,
                  error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
                ),
            );
          }),
        ),
      );

      const data = response.data;

      this.logger.debug(`Keccel OTP Validate API response: ${JSON.stringify(data)}`);

      // Check if the API call was successful (not HTTP error)
      // Even if OTP is invalid, we return a valid response
      const isValid = data.success === 'True' && data.statusOTP === 'VALID';

      this.logger.log(
        `OTP verification ${isValid ? 'succeeded' : 'failed'} for ${phone}`,
      );

      return {
        valid: isValid,
        status: data.statusOTP,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(
        `Unexpected error while verifying OTP: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        'An unexpected error occurred while verifying OTP',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

