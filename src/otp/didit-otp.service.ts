import {
  BadRequestException,
  BadGatewayException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { OtpPurpose } from './otp.types';

const DIDIT_API_ORIGIN = 'https://verification.didit.me';
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SendCodeResponse {
  request_id?: string;
  status?: string;
  vendor_data?: string | null;
}

interface CheckCodeResponse {
  request_id?: string;
  status?: string;
  vendor_data?: string | null;
  phone?: { full_number?: string } | null;
}

export interface DiditSendCodeResult {
  requestId: string;
  status: 'Success' | 'Retry';
}

@Injectable()
export class DiditOtpService {
  private readonly logger = new Logger(DiditOtpService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async sendCode(
    phone: string,
    purpose: OtpPurpose,
    vendorData: string,
  ): Promise<DiditSendCodeResult> {
    const codeSize = purpose === 'phone_verification' ? 5 : 6;
    const data = await firstValueFrom(
      this.httpService.post<SendCodeResponse>(
        `${DIDIT_API_ORIGIN}/v3/phone/send/`,
        {
          phone_number: phone,
          options: {
            code_size: codeSize,
            preferred_channel: this.preferredChannel(),
            locale: 'fr',
          },
          vendor_data: vendorData,
        },
        this.requestOptions(),
      ),
    )
      .then((response) => response.data)
      .catch((error: unknown) => this.providerFailure('send', error));

    if (data?.status === 'Blocked') {
      throw new HttpException(
        'Envoi OTP temporairement refusé',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (
      !data ||
      (data.status !== 'Success' && data.status !== 'Retry') ||
      !REQUEST_ID_PATTERN.test(data.request_id || '') ||
      data.vendor_data !== vendorData
    ) {
      this.logger.error('Didit OTP send returned an invalid response');
      throw new BadGatewayException('Réponse invalide du service OTP');
    }
    return { requestId: data.request_id!, status: data.status };
  }

  async verifyCode(
    phone: string,
    code: string,
    requestId: string,
    vendorData: string,
  ): Promise<boolean> {
    if (!REQUEST_ID_PATTERN.test(requestId)) return false;

    const data = await firstValueFrom(
      this.httpService.post<CheckCodeResponse>(
        `${DIDIT_API_ORIGIN}/v3/phone/check/`,
        { phone_number: phone, code },
        this.requestOptions(),
      ),
    )
      .then((response) => response.data)
      .catch((error: unknown) => this.providerFailure('check', error));

    if (
      !data ||
      !['Approved', 'Declined', 'Failed', 'Expired or Not Found'].includes(
        data.status || '',
      )
    ) {
      this.logger.error('Didit OTP check returned an invalid response');
      throw new BadGatewayException('Réponse invalide du service OTP');
    }

    return (
      data.status === 'Approved' &&
      data.request_id === requestId &&
      data.vendor_data === vendorData &&
      data.phone?.full_number === phone
    );
  }

  private requestOptions() {
    const apiKey =
      this.configService.get<string>('DIDIT_OTP_API_KEY')?.trim() ||
      this.configService.get<string>('DIDIT_API_KEY')?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException('Fournisseur OTP non configuré');
    }
    return {
      headers: {
        'x-api-key': apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 10000,
      maxRedirects: 0,
    };
  }

  private preferredChannel(): 'whatsapp' | 'sms' {
    const channel =
      this.configService
        .get<string>('DIDIT_OTP_CHANNEL')
        ?.trim()
        .toLowerCase() || 'whatsapp';
    if (channel !== 'whatsapp' && channel !== 'sms') {
      throw new ServiceUnavailableException('Canal OTP Didit non configuré');
    }
    return channel;
  }

  private providerFailure(operation: 'send' | 'check', error: unknown): never {
    const status = isAxiosError(error) ? error.response?.status : undefined;
    this.logger.error(
      `Didit OTP ${operation} failed (${status ? `HTTP ${status}` : 'network error'})`,
    );
    if (status === 400) {
      throw new BadRequestException('Numéro de téléphone ou code OTP invalide');
    }
    if (status === 429) {
      throw new HttpException(
        'Trop de tentatives OTP, réessayez plus tard',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    throw new ServiceUnavailableException(
      'Service OTP temporairement indisponible',
    );
  }
}
