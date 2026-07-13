import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { isAxiosError, type AxiosError } from 'axios';
import { PaymentMethod } from './entities/payment-transaction.entity';
import { formatPaymentLogPayload } from './payment-log.util';

export interface FlexPayInitiatePaymentInput {
  method: PaymentMethod;
  reference: string;
  phone?: string;
  amount: number;
  currency: string;
  description: string;
  callbackUrl: string;
  approveUrl?: string;
  cancelUrl?: string;
  declineUrl?: string;
}

export interface FlexPayInitiatePaymentResult {
  code: string;
  message: string | null;
  orderNumber: string | null;
  paymentUrl: string | null;
  raw: Record<string, unknown>;
}

export interface FlexPayInitiatePayoutInput {
  reference: string;
  phone: string;
  amount: number;
  currency: string;
  callbackUrl: string;
}

export interface FlexPayTransactionStatus {
  orderNumber: string | null;
  reference: string | null;
  code?: string | null;
  status: string | null;
  amount: string | null;
  amountCustomer: string | null;
  currency: string | null;
  createdAt: string | null;
}

export interface FlexPayCheckTransactionResult {
  code: string;
  message: string | null;
  transaction: FlexPayTransactionStatus | null;
  raw: Record<string, unknown>;
}

@Injectable()
export class FlexPayService {
  private readonly logger = new Logger(FlexPayService.name);
  private readonly successCode = '0';
  private readonly defaultMobileBaseUrl = 'https://beta-backend.flexpay.cd';
  private readonly defaultCardBaseUrl = 'https://beta-cardpayment.flexpay.cd';
  private readonly defaultCardPaymentPath = 'v1.1/pay';
  private readonly defaultRequestTimeoutMs = 30000;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async initiatePayment(
    input: FlexPayInitiatePaymentInput,
  ): Promise<FlexPayInitiatePaymentResult> {
    if (input.method === PaymentMethod.CARD) {
      return this.initiateCardPayment(input);
    }

    return this.initiateMobileMoneyPayment(input);
  }

  async initiatePayout(
    input: FlexPayInitiatePayoutInput,
  ): Promise<FlexPayInitiatePaymentResult> {
    if (!input.phone?.trim()) {
      throw new BadRequestException(
        'Le numero de telephone est requis pour un paiement chauffeur',
      );
    }

    const body = {
      merchant: this.getMerchantCode(),
      type: '1',
      phone: this.normalizePhone(input.phone),
      reference: input.reference,
      amount: this.formatAmount(input.amount),
      currency: input.currency,
      callbackUrl: input.callbackUrl,
    };
    const url = this.getMerchantPayoutUrl();

    this.logger.log(
      `FlexPay merchant payout request: url=${url}, merchant=${body.merchant}, reference=${body.reference}, phone=${this.maskPhone(body.phone)}, amount=${body.amount} ${body.currency}`,
    );

    try {
      const response = await firstValueFrom(
        this.httpService.post<Record<string, unknown>>(url, body, {
          headers: {
            Authorization: this.getBearerToken(),
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: this.getRequestTimeoutMs(),
        }),
      );

      const normalizedResponse = this.normalizeInitiateResponse(response.data);
      this.logger.log(
        `FlexPay merchant payout response: reference=${input.reference}, code=${normalizedResponse.code}, orderNumber=${normalizedResponse.orderNumber ?? 'none'}, message=${normalizedResponse.message ?? 'none'}, response=${formatPaymentLogPayload(normalizedResponse.raw)}`,
      );

      return normalizedResponse;
    } catch (error) {
      this.handleHttpError(error, 'Paiement chauffeur FlexPay');
    }
  }

  async checkTransaction(
    orderNumber: string,
  ): Promise<FlexPayCheckTransactionResult> {
    if (!orderNumber?.trim()) {
      throw new BadRequestException('Le numero de commande FlexPay est requis');
    }

    const normalizedOrderNumber = orderNumber.trim();
    const url = this.getCheckTransactionUrl(normalizedOrderNumber);

    this.logger.log(
      `FlexPay check request: orderNumber=${normalizedOrderNumber}, url=${url}`,
    );

    try {
      const response = await firstValueFrom(
        this.httpService.get<Record<string, unknown>>(url, {
          headers: {
            Authorization: this.getBearerToken(),
            Accept: 'application/json',
          },
          timeout: this.getRequestTimeoutMs(),
        }),
      );

      const normalizedResponse = this.normalizeCheckResponse(response.data);
      this.logger.log(
        `FlexPay check response: orderNumber=${normalizedOrderNumber}, code=${normalizedResponse.code}, transactionStatus=${normalizedResponse.transaction?.status ?? 'none'}, transactionReference=${normalizedResponse.transaction?.reference ?? 'none'}, response=${formatPaymentLogPayload(normalizedResponse.raw)}`,
      );

      return normalizedResponse;
    } catch (error) {
      this.handleHttpError(error, 'Verification FlexPay');
    }
  }

  isSuccessfulCode(code: string | number | null | undefined): boolean {
    return String(code ?? '') === this.successCode;
  }

  isSuccessfulTransaction(
    transaction: FlexPayTransactionStatus | null | undefined,
  ): boolean {
    return this.isSuccessfulCode(transaction?.status ?? transaction?.code);
  }

  private async initiateMobileMoneyPayment(
    input: FlexPayInitiatePaymentInput,
  ): Promise<FlexPayInitiatePaymentResult> {
    if (!input.phone?.trim()) {
      throw new BadRequestException(
        'Le numero de telephone est requis pour un paiement Mobile Money',
      );
    }

    const body = {
      merchant: this.getMerchantCode(),
      type: '1',
      phone: this.normalizePhone(input.phone),
      reference: input.reference,
      amount: this.formatAmount(input.amount),
      currency: input.currency,
      callbackUrl: input.callbackUrl,
    };
    const url = this.getMobilePaymentUrl();

    this.logger.log(
      `FlexPay Mobile Money request: url=${url}, merchant=${body.merchant}, reference=${body.reference}, phone=${this.maskPhone(body.phone)}, amount=${body.amount} ${body.currency}`,
    );

    try {
      const response = await firstValueFrom(
        this.httpService.post<Record<string, unknown>>(url, body, {
          headers: {
            Authorization: this.getBearerToken(),
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: this.getRequestTimeoutMs(),
        }),
      );

      const normalizedResponse = this.normalizeInitiateResponse(response.data);
      this.logger.log(
        `FlexPay Mobile Money response: reference=${input.reference}, code=${normalizedResponse.code}, orderNumber=${normalizedResponse.orderNumber ?? 'none'}, message=${normalizedResponse.message ?? 'none'}, response=${formatPaymentLogPayload(normalizedResponse.raw)}`,
      );

      return normalizedResponse;
    } catch (error) {
      this.handleHttpError(
        error,
        'Initialisation paiement Mobile Money FlexPay',
      );
    }
  }

  private async initiateCardPayment(
    input: FlexPayInitiatePaymentInput,
  ): Promise<FlexPayInitiatePaymentResult> {
    const body = {
      authorization: this.getBearerToken(),
      merchant: this.getMerchantCode(),
      reference: input.reference,
      amount: this.formatAmount(input.amount),
      currency: input.currency,
      description: input.description,
      callback_url: input.callbackUrl,
      approve_url: this.getRequiredRedirectUrl(
        input.approveUrl,
        'FLEXPAY_CARD_APPROVE_URL',
      ),
      cancel_url: this.getRequiredRedirectUrl(
        input.cancelUrl,
        'FLEXPAY_CARD_CANCEL_URL',
      ),
      decline_url: this.getRequiredRedirectUrl(
        input.declineUrl,
        'FLEXPAY_CARD_DECLINE_URL',
      ),
    };
    const url = this.getCardPaymentUrl();

    this.logger.log(
      `FlexPay card request: url=${url}, merchant=${body.merchant}, reference=${body.reference}, amount=${body.amount} ${body.currency}, approveUrl=${body.approve_url}, cancelUrl=${body.cancel_url}, declineUrl=${body.decline_url}`,
    );

    try {
      const response = await firstValueFrom(
        this.httpService.post<Record<string, unknown>>(url, body, {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: this.getRequestTimeoutMs(),
        }),
      );

      const normalizedResponse = this.normalizeInitiateResponse(response.data);
      this.logger.log(
        `FlexPay card response: reference=${input.reference}, code=${normalizedResponse.code}, orderNumber=${normalizedResponse.orderNumber ?? 'none'}, hasPaymentUrl=${Boolean(normalizedResponse.paymentUrl)}, message=${normalizedResponse.message ?? 'none'}, response=${formatPaymentLogPayload(normalizedResponse.raw)}`,
      );

      return normalizedResponse;
    } catch (error) {
      this.handleHttpError(error, 'Initialisation paiement carte FlexPay');
    }
  }

  private normalizeInitiateResponse(
    data: Record<string, unknown>,
  ): FlexPayInitiatePaymentResult {
    return {
      code: this.getStringValue(data, 'code', 'Code') ?? '',
      message: this.getStringValue(data, 'message', 'Message'),
      orderNumber: this.getStringValue(data, 'orderNumber'),
      paymentUrl: this.getStringValue(data, 'url'),
      raw: data,
    };
  }

  private normalizeCheckResponse(
    data: Record<string, unknown>,
  ): FlexPayCheckTransactionResult {
    const rawTransaction =
      this.getObjectValue(data, 'transaction', 'Transaction') ?? null;

    return {
      code: this.getStringValue(data, 'code', 'Code') ?? '',
      message: this.getStringValue(data, 'message', 'Message'),
      transaction: rawTransaction
        ? {
            orderNumber: this.getStringValue(rawTransaction, 'orderNumber'),
            reference: this.getStringValue(rawTransaction, 'reference'),
            code: this.getStringValue(rawTransaction, 'code', 'Code'),
            status: this.getStringValue(rawTransaction, 'status', 'Status'),
            amount: this.getStringValue(rawTransaction, 'amount'),
            amountCustomer: this.getStringValue(
              rawTransaction,
              'amountCustomer',
            ),
            currency: this.getStringValue(rawTransaction, 'currency'),
            createdAt: this.getStringValue(rawTransaction, 'createdAt'),
          }
        : null,
      raw: data,
    };
  }

  private getObjectValue(
    data: Record<string, unknown>,
    ...keys: string[]
  ): Record<string, unknown> | null {
    for (const key of keys) {
      const value = data[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    }

    return null;
  }

  private getStringValue(
    data: Record<string, unknown>,
    ...keys: string[]
  ): string | null {
    for (const key of keys) {
      const value = data[key];
      if (value !== undefined && value !== null) {
        return String(value);
      }
    }

    return null;
  }

  private getBearerToken(): string {
    const token = this.getRequiredConfigFrom([
      'FLEXPAY_TOKEN',
      'FLEX_PAIE_TOKEN',
    ]);
    return token.toLowerCase().startsWith('bearer ')
      ? token
      : `Bearer ${token}`;
  }

  private getMerchantCode(): string {
    return this.getRequiredConfigFrom([
      'FLEXPAY_MERCHANT_CODE',
      'FLEXPAY_MERCHANT',
    ]);
  }

  private getMobilePaymentUrl(): string {
    const explicitUrl = this.getOptionalConfig('FLEXPAY_PAYMENT_SERVICE_URL');
    if (explicitUrl) {
      return explicitUrl;
    }

    return this.joinUrl(
      this.getOptionalConfig('FLEXPAY_MOBILE_BASE_URL') ||
        this.defaultMobileBaseUrl,
      'api/rest/v1/paymentService',
    );
  }

  private getMerchantPayoutUrl(): string {
    const explicitUrl = this.getOptionalConfig('FLEXPAY_PAYOUT_SERVICE_URL');
    if (explicitUrl) {
      return explicitUrl;
    }

    return this.joinUrl(
      this.getOptionalConfig('FLEXPAY_MOBILE_BASE_URL') ||
        this.defaultMobileBaseUrl,
      'api/rest/v1/merchantPayOutService',
    );
  }

  private getCardPaymentUrl(): string {
    const explicitUrl = this.getOptionalConfig('FLEXPAY_CARD_PAYMENT_URL');
    if (explicitUrl) {
      return explicitUrl;
    }

    return this.joinUrl(
      this.getOptionalConfig('FLEXPAY_CARD_BASE_URL') ||
        this.defaultCardBaseUrl,
      this.getOptionalConfig('FLEXPAY_CARD_PAYMENT_PATH') ||
        this.defaultCardPaymentPath,
    );
  }

  private getCheckTransactionUrl(orderNumber: string): string {
    const explicitUrl = this.getOptionalConfig('FLEXPAY_CHECK_TRANSACTION_URL');
    if (explicitUrl?.includes('{orderNumber}')) {
      return explicitUrl.replace(
        '{orderNumber}',
        encodeURIComponent(orderNumber),
      );
    }

    if (explicitUrl) {
      return this.joinUrl(explicitUrl, encodeURIComponent(orderNumber));
    }

    const baseUrl =
      this.getOptionalConfig('FLEXPAY_CHECK_BASE_URL') ||
      this.getOptionalConfig('FLEXPAY_MOBILE_BASE_URL') ||
      this.defaultMobileBaseUrl;

    return this.joinUrl(
      baseUrl,
      'api/rest/v1/check',
      encodeURIComponent(orderNumber),
    );
  }

  private getRequiredRedirectUrl(
    value: string | undefined,
    configKey: string,
  ): string {
    const url = value?.trim() || this.getOptionalConfig(configKey);
    if (!url) {
      throw new BadRequestException(
        `${configKey} doit etre configure pour un paiement par carte`,
      );
    }

    return url;
  }

  private getRequiredConfigFrom(keys: string[]): string {
    for (const key of keys) {
      const value = this.getOptionalConfig(key);
      if (value) {
        return value;
      }
    }

    throw new BadRequestException(`${keys.join(' ou ')} n'est pas configure`);
  }

  private getOptionalConfig(key: string): string | null {
    const value = this.configService.get<string>(key)?.trim();
    return value ? value : null;
  }

  private joinUrl(...parts: string[]): string {
    return parts
      .map((part, index) =>
        index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, ''),
      )
      .filter(Boolean)
      .join('/');
  }

  private formatAmount(amount: number): string {
    return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  }

  private getRequestTimeoutMs(): number {
    const rawValue = this.configService.get<string | number>(
      'FLEXPAY_REQUEST_TIMEOUT_MS',
    );
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : this.defaultRequestTimeoutMs;
  }

  private normalizePhone(phone: string): string {
    const normalized = phone.trim().replace(/[\s()-]/g, '');
    if (!/^\+243\d{9}$/.test(normalized)) {
      throw new BadRequestException(
        'Le numero de telephone doit commencer par +243, par exemple +243891234567',
      );
    }

    return normalized.slice(1);
  }

  private maskPhone(phone: string): string {
    if (phone.length <= 6) {
      return '***';
    }

    return `${phone.slice(0, 3)}***${phone.slice(-4)}`;
  }

  private handleHttpError(error: unknown, context: string): never {
    if (error instanceof HttpException) {
      throw error;
    }

    const axiosError = isAxiosError(error)
      ? error
      : (error as AxiosError);
    const responseData = formatPaymentLogPayload(
      axiosError.response?.data ?? axiosError.message,
    );
    const status = axiosError.response?.status ?? 'unknown';
    const method = axiosError.config?.method?.toUpperCase() ?? 'unknown';
    const url = axiosError.config?.url ?? 'unknown';
    const code = axiosError.code ?? 'none';
    const publicReason = this.getPublicHttpErrorReason(axiosError);

    this.logger.error(
      `${context} failed: status=${status}, code=${code}, method=${method}, url=${url}, reason=${publicReason ?? 'none'}, response=${responseData}`,
    );
    throw new BadGatewayException(
      publicReason
        ? `${context} indisponible (${publicReason})`
        : `${context} indisponible`,
    );
  }

  private getPublicHttpErrorReason(error: AxiosError): string | null {
    const message = error.message?.toLowerCase() ?? '';
    const timeout =
      typeof error.config?.timeout === 'number' && error.config.timeout > 0
        ? `${error.config.timeout}ms`
        : null;

    if (error.code === 'ECONNABORTED' || message.includes('timeout')) {
      return timeout ? `delai depasse apres ${timeout}` : 'delai depasse';
    }

    if (error.code === 'ENOTFOUND') {
      return 'hote flexpay introuvable';
    }

    if (
      error.code === 'ECONNREFUSED' ||
      error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT'
    ) {
      return 'connexion flexpay impossible';
    }

    if (error.response?.status) {
      return `reponse flexpay ${error.response.status}`;
    }

    return null;
  }
}
