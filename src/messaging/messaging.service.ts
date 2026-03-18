import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface MessagingMessage {
  to: string; // Numero au format international (ex: +243900000000)
  message: string;
}

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly from: string;
  private readonly whatsappEnabled: boolean;
  private readonly keccelSmsUrl: string;
  private readonly keccelToken: string;
  private readonly keccelFrom: string;
  private readonly keccelSmsEnabled: boolean;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    const infobipBaseUrl = this.configService.get<string>('INFOBIP_BASE_URL') || '';
    const explicitApiUrl =
      this.configService.get<string>('INFOBIP_WHATSAPP_API_URL') ||
      this.configService.get<string>('WHATSAPP_API_URL') ||
      '';

    this.apiUrl =
      explicitApiUrl ||
      (infobipBaseUrl ? `${infobipBaseUrl.replace(/\/+$/, '')}/whatsapp/1/message/text` : '');
    this.apiKey =
      this.configService.get<string>('INFOBIP_API_KEY') ||
      this.configService.get<string>('WHATSAPP_API_KEY') ||
      '';
    this.from =
      this.configService.get<string>('INFOBIP_WHATSAPP_FROM') ||
      this.configService.get<string>('WHATSAPP_FROM') ||
      'Zwanga';
    this.whatsappEnabled =
      (this.configService.get<string>('WHATSAPP_ENABLED') || 'true').toLowerCase() !== 'false';

    this.keccelSmsUrl =
      this.configService.get<string>('KECCEL_SMS_URL') ||
      'https://api.keccel.com/sms/v2/message.asp';
    this.keccelToken = this.configService.get<string>('KECCEL_TOKEN') || '';
    this.keccelFrom = this.configService.get<string>('KECCEL_FROM') || '';
    this.keccelSmsEnabled =
      (this.configService.get<string>('KECCEL_SMS_ENABLED') || 'true').toLowerCase() !== 'false';
  }

  /**
   * Envoie un message WhatsApp a un numero de telephone
   */
  async sendMessage(
    to: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    const rawPhone = to;
    const formattedPhone = this.formatPhoneNumber(to);
    const phoneForLog = this.maskPhone(formattedPhone);
    const preview = this.buildMessagePreview(message);

    const canSendWhatsApp = !!(
      this.whatsappEnabled &&
      this.apiUrl &&
      this.apiKey &&
      this.from
    );
    const canSendSms = !!(
      this.keccelSmsEnabled &&
      this.keccelSmsUrl &&
      this.keccelToken &&
      this.keccelFrom
    );

    if (!canSendWhatsApp && !canSendSms) {
      this.logger.warn(
        `[MSG][SKIP][NOT_CONFIGURED] to=${phoneForLog} meta=${JSON.stringify(
          metadata ?? {},
        )} preview="${preview}"`,
      );
      return false;
    }

    let whatsappSent = false;
    let smsSent = false;

    if (canSendWhatsApp) {
      this.logger.log(
        `[WA][TRY] to=${phoneForLog} from=${this.from} meta=${JSON.stringify(
          metadata ?? {},
        )} length=${message.length} preview="${preview}"`,
      );
      whatsappSent = await this.sendMessageWithInfobip(
        rawPhone,
        formattedPhone,
        message,
        metadata,
      );
    } else {
      this.logger.debug(
        `[WA][SKIP][NOT_CONFIGURED] to=${phoneForLog} meta=${JSON.stringify(metadata ?? {})}`,
      );
    }

    if (canSendSms) {
      const smsMessage = this.normalizeTextForSms(message);
      this.logger.log(
        `[SMS][TRY] to=${phoneForLog} from=${this.keccelFrom} meta=${JSON.stringify(
          metadata ?? {},
        )} length=${smsMessage.length}`,
      );
      smsSent = await this.sendSmsWithKeccel(
        rawPhone,
        formattedPhone,
        smsMessage,
        metadata,
      );
    } else {
      this.logger.debug(
        `[SMS][SKIP][NOT_CONFIGURED] to=${phoneForLog} meta=${JSON.stringify(metadata ?? {})}`,
      );
    }

    const delivered = whatsappSent || smsSent;
    this.logger.log(
      `[MSG][RESULT] to=${phoneForLog} delivered=${delivered} whatsapp=${whatsappSent} sms=${smsSent} meta=${JSON.stringify(
        metadata ?? {},
      )}`,
    );
    return delivered;
  }

  /**
   * Envoie des messages WhatsApp a plusieurs destinataires
   */
  async sendToMultiple(
    recipients: MessagingMessage[],
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const recipient of recipients) {
      const result = await this.sendMessage(recipient.to, recipient.message);
      if (result) {
        success++;
      } else {
        failed++;
      }
    }

    this.logger.log(`WhatsApp messages sent: ${success} success, ${failed} failed`);
    return { success, failed };
  }

  private async sendMessageWithInfobip(
    rawTo: string,
    to: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    const headers = {
      Authorization: `App ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const payloadVariants = [
      {
        from: this.from,
        to,
        content: {
          text: message,
        },
      },
      {
        messages: [
          {
            from: this.from,
            to,
            content: {
              text: message,
            },
          },
        ],
      },
    ];

    let lastError: any = null;

    for (let index = 0; index < payloadVariants.length; index += 1) {
      const payload = payloadVariants[index];
      try {
        this.logger.debug(
          `[WA][INFobip][ATTEMPT] variant=${index + 1}/${payloadVariants.length} to=${this.maskPhone(
            to,
          )} meta=${JSON.stringify(metadata ?? {})}`,
        );
        const response = await firstValueFrom(
          this.httpService.post(this.apiUrl, payload, { headers }),
        );

        const info =
          response?.data?.messages?.[0] ??
          response?.data?.results?.[0] ??
          response?.data;
        const statusGroupId = Number(info?.status?.groupId ?? 0);
        const statusDescription = info?.status?.description || 'unknown';
        const messageId = info?.messageId || null;

        if (statusGroupId >= 5) {
          this.logger.warn(
            `[WA][FAILED][PROVIDER_STATUS] to=${this.maskPhone(
              to,
            )} groupId=${statusGroupId} description=${statusDescription} messageId=${
              messageId ?? 'n/a'
            } meta=${JSON.stringify(metadata ?? {})}`,
          );
          return false;
        }

        this.logger.log(
          `[WA][SENT] to=${this.maskPhone(to)} messageId=${messageId ?? 'n/a'} groupId=${
            Number.isFinite(statusGroupId) ? statusGroupId : 'n/a'
          } description=${statusDescription} meta=${JSON.stringify(metadata ?? {})}`,
        );
        return true;
      } catch (error) {
        lastError = error;
        const parsedError = this.parseInfobipError(error);
        this.logger.warn(
          `[WA][RETRY] variant=${index + 1}/${payloadVariants.length} to=${this.maskPhone(
            to,
          )} reason="${parsedError.summary}" category=${parsedError.category} status=${
            parsedError.status ?? 'n/a'
          } providerCode=${parsedError.providerCode ?? 'n/a'} providerMessage="${
            parsedError.providerMessage
          }" validation="${parsedError.validationSummary}" meta=${JSON.stringify(
            metadata ?? {},
          )}`,
        );
      }
    }

    const parsedError = this.parseInfobipError(lastError);
    this.logger.error(
      `[WA][FAILED][INFOBIP] to=${this.maskPhone(to)} rawTo=${this.maskPhone(
        rawTo,
      )} reason="${parsedError.summary}" category=${parsedError.category} status=${
        parsedError.status ?? 'n/a'
      } providerCode=${parsedError.providerCode ?? 'n/a'} providerMessage="${
        parsedError.providerMessage
      }" validation="${parsedError.validationSummary}" meta=${JSON.stringify(metadata ?? {})}`,
      lastError?.stack,
    );

    return false;
  }

  private async sendSmsWithKeccel(
    rawTo: string,
    to: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    const requestBody = {
      token: this.keccelToken,
      from: this.keccelFrom,
      to,
      message,
    };
    const requestVariants: Array<{
      label: 'json' | 'form';
      body: Record<string, string> | string;
      headers: Record<string, string>;
    }> = [
      {
        label: 'json',
        body: requestBody,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
        },
      },
      {
        label: 'form',
        body: new URLSearchParams(requestBody).toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json, text/plain, */*',
        },
      },
    ];

    let lastError: any = null;

    for (let index = 0; index < requestVariants.length; index += 1) {
      const variant = requestVariants[index];
      try {
        const response = await firstValueFrom(
          this.httpService.post(this.keccelSmsUrl, variant.body, {
            headers: variant.headers,
          }),
        );

        const data = response?.data ?? {};
        if (!this.isKeccelSmsSuccess(data)) {
          const providerStatus = data?.status ?? data?.success ?? data?.code ?? 'unknown';
          const providerMessage =
            data?.description ||
            data?.message ||
            data?.error ||
            `Keccel SMS rejected request (${variant.label})`;
          this.logger.warn(
            `[SMS][FAILED][PROVIDER_STATUS] variant=${variant.label} to=${this.maskPhone(
              to,
            )} status=${providerStatus} message="${providerMessage}" meta=${JSON.stringify(
              metadata ?? {},
            )}`,
          );
          continue;
        }

        this.logger.log(
          `[SMS][SENT][KECCEL] variant=${variant.label} to=${this.maskPhone(to)} status=${
            data?.status ?? data?.success ?? data?.code ?? 'ok'
          } meta=${JSON.stringify(metadata ?? {})}`,
        );
        return true;
      } catch (error) {
        lastError = error;
        const parsedError = this.parseKeccelSmsError(error);
        this.logger.warn(
          `[SMS][RETRY] variant=${variant.label} to=${this.maskPhone(to)} reason="${
            parsedError.summary
          }" category=${parsedError.category} status=${parsedError.status ?? 'n/a'} providerCode=${
            parsedError.providerCode ?? 'n/a'
          } providerMessage="${parsedError.providerMessage}" meta=${JSON.stringify(
            metadata ?? {},
          )}`,
        );
      }
    }

    const parsedError = this.parseKeccelSmsError(lastError);
    this.logger.error(
      `[SMS][FAILED][KECCEL] to=${this.maskPhone(to)} rawTo=${this.maskPhone(
        rawTo,
      )} reason="${parsedError.summary}" category=${parsedError.category} status=${
        parsedError.status ?? 'n/a'
      } providerCode=${parsedError.providerCode ?? 'n/a'} providerMessage="${
        parsedError.providerMessage
      }" meta=${JSON.stringify(metadata ?? {})}`,
      lastError?.stack,
    );
    return false;
  }

  private isKeccelSmsSuccess(data: any): boolean {
    if (typeof data === 'string') {
      const normalized = data.trim().toUpperCase();
      return (
        normalized.includes('SENT') ||
        normalized.includes('SUCCESS') ||
        normalized.includes('OK')
      );
    }

    const status = String(data?.status || '').toUpperCase();
    const success = String(data?.success || '').toLowerCase();
    const code = String(data?.code || data?.statusCode || data?.resultCode || '').toLowerCase();

    if (status === 'SENT' || status === 'SUCCESS' || status === 'OK') {
      return true;
    }

    if (success === 'true' || success === '1' || success === 'ok') {
      return true;
    }

    if (code === '0' || code === 'ok' || code === 'success') {
      return true;
    }

    // Some providers return HTTP 200 with no explicit status field for accepted requests.
    if (typeof data === 'object' && !data?.status && !data?.success && !data?.error) {
      return true;
    }

    return false;
  }

  private parseKeccelSmsError(error: any): {
    status?: number;
    category: string;
    summary: string;
    providerCode?: string;
    providerMessage: string;
  } {
    const status = error?.response?.status as number | undefined;
    const data = error?.response?.data;

    const providerCode = data?.code || data?.errorCode || data?.statusCode || undefined;
    const providerMessage =
      data?.description ||
      data?.message ||
      data?.error ||
      error?.message ||
      'Unknown Keccel SMS error';

    let category = 'provider_error';
    if (status === 400) {
      category = 'invalid_request';
    } else if (status === 401 || status === 403) {
      category = 'authentication_error';
    } else if (status === 404) {
      category = 'endpoint_not_found';
    } else if (status === 429) {
      category = 'rate_limited';
    } else if (typeof status === 'number' && status >= 500) {
      category = 'provider_unavailable';
    } else if (!status) {
      category = 'network_error';
    }

    const summaryParts = [
      category.replace(/_/g, ' '),
      providerCode ? `code ${providerCode}` : null,
      providerMessage,
    ].filter(Boolean);

    return {
      status,
      category,
      summary: summaryParts.join(' - '),
      providerCode,
      providerMessage,
    };
  }

  private normalizeTextForSms(message: string): string {
    return message
      .replace(/[*_~`]/g, '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private parseInfobipError(error: any): {
    status?: number;
    category: string;
    summary: string;
    providerCode?: string;
    providerMessage: string;
    validationSummary: string;
  } {
    const status = error?.response?.status as number | undefined;
    const data = error?.response?.data;

    const providerCode =
      data?.requestError?.serviceException?.messageId ||
      data?.requestError?.policyException?.messageId ||
      data?.error?.code ||
      data?.messageId ||
      undefined;
    const providerMessage =
      data?.requestError?.serviceException?.text ||
      data?.requestError?.policyException?.text ||
      data?.error?.message ||
      data?.message ||
      error?.message ||
      'Unknown Infobip error';

    const validationErrors =
      data?.requestError?.serviceException?.validationErrors ||
      data?.requestError?.policyException?.validationErrors ||
      [];
    const validationSummary = Array.isArray(validationErrors) && validationErrors.length > 0
      ? validationErrors
          .map((item: any) => {
            const field = item?.propertyName || item?.field || 'field';
            const message = item?.message || item?.error || 'invalid value';
            return `${field}: ${message}`;
          })
          .join(' | ')
      : 'none';

    let category = 'provider_error';
    if (status === 400) {
      category = 'invalid_request';
    } else if (status === 401 || status === 403) {
      category = 'authentication_error';
    } else if (status === 404) {
      category = 'endpoint_not_found';
    } else if (status === 429) {
      category = 'rate_limited';
    } else if (typeof status === 'number' && status >= 500) {
      category = 'provider_unavailable';
    } else if (!status) {
      category = 'network_error';
    }

    const summaryParts = [
      category.replace(/_/g, ' '),
      providerCode ? `code ${providerCode}` : null,
      providerMessage,
      validationSummary !== 'none' ? `details: ${validationSummary}` : null,
    ].filter(Boolean);

    return {
      status,
      category,
      summary: summaryParts.join(' - '),
      providerCode,
      providerMessage,
      validationSummary,
    };
  }

  private maskPhone(phone: string): string {
    if (!phone) {
      return 'n/a';
    }

    const cleaned = phone.replace(/\s+/g, '');
    if (cleaned.length <= 6) {
      return cleaned;
    }
    return `${cleaned.slice(0, 4)}***${cleaned.slice(-3)}`;
  }

  private buildMessagePreview(message: string): string {
    if (!message) {
      return '';
    }
    const compact = message.replace(/\s+/g, ' ').trim();
    return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
  }

  /**
   * Formate un numero de telephone pour WhatsApp (format international)
   */
  private formatPhoneNumber(phone: string): string {
    let formatted = phone.replace(/[\s\-\(\)]/g, '');

    if (!formatted.startsWith('+')) {
      const defaultCountryCode =
        this.configService.get<string>('DEFAULT_COUNTRY_CODE') || '+243';
      formatted = defaultCountryCode + formatted;
    }

    return formatted;
  }

  /**
   * Genere un message WhatsApp pour informer les contacts d'urgence d'un trajet
   */
  generateTripNotificationMessage(data: {
    passengerName: string;
    departureLocation: string;
    arrivalLocation: string;
    departureDate: Date;
    vehicleColor: string;
    licensePlate: string;
    driverName?: string;
    driverPhone?: string;
  }): string {
    const formattedDate = new Date(data.departureDate).toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    let message = `*ZWANGA - Information de Trajet*\n\n`;
    message += `Bonjour,\n\n`;
    message += `${data.passengerName} utilise Zwanga pour un trajet et vous a ajoute comme contact d'urgence.\n\n`;
    message += `*Details du trajet :*\n`;
    message += `Depart : ${data.departureLocation}\n`;
    message += `Arrivee : ${data.arrivalLocation}\n`;
    message += `Date/Heure : ${formattedDate}\n\n`;
    message += `*Informations du vehicule :*\n`;
    message += `Couleur : ${data.vehicleColor}\n`;
    message += `Plaque d'immatriculation : ${data.licensePlate}\n\n`;

    if (data.driverName) {
      message += `*Conducteur :*\n`;
      message += `Nom : ${data.driverName}\n`;
      if (data.driverPhone) {
        message += `Telephone : ${data.driverPhone}\n`;
      }
      message += `\n`;
    }

    message += `En cas d'urgence ou de probleme, contactez ${data.passengerName} ou utilisez l'application Zwanga.\n\n`;
    message += `_Message envoye automatiquement par Zwanga_`;

    return message;
  }
}
