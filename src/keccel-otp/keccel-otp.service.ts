import {
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import {
  firstValueFrom,
  catchError,
  throwError,
  retryWhen,
  concatMap,
  timer,
} from 'rxjs';
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
  private readonly defaultLength = 5;
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
      'https://api.keccel.com/otp/generate';
    this.validateUrl =
      this.configService.get<string>('KECCEL_OTP_URL_VALIDATE') ||
      'https://api.keccel.com/otp/validate';

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
    this.logger.log(`Sending OTP to phone: ${this.maskPhone(phone)}`);

    if (!phone || !phone.trim()) {
      throw new BadRequestException('Le numéro de téléphone est requis');
    }
    const normalizedPhone = this.normalizePhoneForKeccel(phone);

    this.logger.debug(`Token: ${this.maskToken(this.token)}`);
    this.logger.debug(`From: ${this.from}`);
    this.logger.debug(`Phone: ${this.maskPhone(normalizedPhone)}`);
    this.logger.debug(`Message: ${message || this.defaultMessage}`);
    this.logger.debug(`Length: ${length}`);
    this.logger.debug(`Lifetime: ${lifetime}`);

    // Build request body as JSON
    const otpLength = length !== undefined ? length : this.defaultLength;
    const otpLifetime =
      lifetime !== undefined ? lifetime : this.defaultLifetime;

    // Validate length
    if (otpLength < 4 || otpLength > 8) {
      throw new BadRequestException(
        'La longueur du code OTP doit être entre 4 et 8',
      );
    }

    // Validate lifetime
    if (otpLifetime < 60) {
      throw new BadRequestException(
        "La durée de vie du code OTP doit être d'au moins 60 secondes",
      );
    }

    if (otpLifetime > 600) {
      throw new BadRequestException(
        'La duree de vie du code OTP doit etre inferieure ou egale a 600 secondes',
      );
    }

    const requestBody: any = {
      token: this.token,
      from: this.from,
      to: normalizedPhone,
      message: message || this.defaultMessage,
      length: otpLength,
      lifetime: otpLifetime,
    };

    try {
      this.logger.debug(`Calling Keccel OTP Generate API: ${this.generateUrl}`);
      this.logger.debug(
        `Request body: ${JSON.stringify(this.redactRequestBody(requestBody))}`,
      );

      const response = await firstValueFrom(
        this.httpService
          .post<KeccelOtpGenerateResponse>(this.generateUrl, requestBody, {
            headers: {
              'Content-Type': 'application/json',
            },
          })
          .pipe(
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

      this.logger.debug(
        `Keccel OTP Generate API response: ${JSON.stringify(data)}`,
      );

      if (this.isGenerateSuccess(data)) {
        this.logger.log(
          `OTP sent successfully to ${this.maskPhone(normalizedPhone)}`,
        );
        return {
          success: true,
          message: data.description || 'Code OTP envoyé avec succès',
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
        let errorMessage = data.description || "Échec de l'envoi du code OTP";
        if (
          data.description?.includes('FROM') ||
          data.description?.includes('from')
        ) {
          errorMessage = `Erreur de configuration : Paramètre FROM invalide. Veuillez vérifier la variable d'environnement KECCEL_FROM. Valeur actuelle : ${this.from}`;
        }

        throw new HttpException(errorMessage, HttpStatus.BAD_REQUEST);
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
        "Une erreur inattendue s'est produite lors de l'envoi du code OTP",
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
    this.logger.log(`Verifying OTP for phone: ${this.maskPhone(phone)}`);

    if (!phone || !phone.trim()) {
      throw new BadRequestException('Le numéro de téléphone est requis');
    }

    if (!otp || !otp.trim()) {
      throw new BadRequestException('Le code OTP est requis');
    }

    const normalizedPhone = this.normalizePhoneForKeccel(phone);

    // Build request body as JSON
    const requestBody = {
      token: this.token,
      from: this.from,
      to: normalizedPhone,
      otp: otp.trim(),
    };

    try {
      this.logger.debug(`Calling Keccel OTP Validate API: ${this.validateUrl}`);
      this.logger.debug(
        `Request body: ${JSON.stringify(this.redactRequestBody(requestBody))}`,
      );

      const response = await firstValueFrom(
        this.httpService
          .request<KeccelOtpValidateResponse>({
            method: 'GET',
            url: this.validateUrl,
            data: requestBody,
            headers: {
              'Content-Type': 'application/json',
            },
          })
          .pipe(
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

      this.logger.debug(
        `Keccel OTP Validate API response: ${JSON.stringify(data)}`,
      );

      // Check if the API call was successful (not HTTP error)
      // Even if OTP is invalid, we return a valid response
      const isValid =
        String(data.success || '').toLowerCase() === 'true' &&
        String(data.statusOTP || '').toUpperCase() === 'VALID';

      this.logger.log(
        `OTP verification ${isValid ? 'succeeded' : 'failed'} for ${this.maskPhone(normalizedPhone)}`,
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

  private normalizePhoneForKeccel(phone: string): string {
    const defaultCountryCode = (
      this.configService.get<string>('DEFAULT_COUNTRY_CODE') || '+243'
    ).replace(/\D/g, '');

    let normalized = phone.trim().replace(/[\s().-]/g, '');

    if (normalized.startsWith('+')) {
      normalized = normalized.slice(1);
    }

    if (normalized.startsWith('00')) {
      normalized = normalized.slice(2);
    }

    if (normalized.startsWith('0')) {
      normalized = `${defaultCountryCode}${normalized.slice(1)}`;
    } else if (
      defaultCountryCode &&
      !normalized.startsWith(defaultCountryCode) &&
      /^\d{8,10}$/.test(normalized)
    ) {
      normalized = `${defaultCountryCode}${normalized}`;
    }

    if (!/^\d{8,15}$/.test(normalized)) {
      throw new BadRequestException(
        'Le numero de telephone doit etre au format international, par exemple +243900000000',
      );
    }

    return normalized;
  }

  private isGenerateSuccess(data: KeccelOtpGenerateResponse): boolean {
    return String(data?.status || '').toUpperCase() === 'SENT';
  }

  private redactRequestBody(body: Record<string, any>): Record<string, any> {
    return {
      ...body,
      token: this.maskToken(String(body.token || '')),
      to: this.maskPhone(String(body.to || '')),
    };
  }

  private maskPhone(phone: string): string {
    const cleaned = phone.replace(/\s+/g, '');
    if (cleaned.length <= 6) {
      return cleaned;
    }

    return `${cleaned.slice(0, 4)}***${cleaned.slice(-3)}`;
  }

  private maskToken(token: string): string {
    if (!token) {
      return 'n/a';
    }

    if (token.length <= 6) {
      return '***';
    }

    return `${token.slice(0, 3)}***${token.slice(-3)}`;
  }
}
