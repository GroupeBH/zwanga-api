import {
  BadGatewayException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import type {
  FlexPayCheckTransactionResult,
  FlexPayInitiatePayoutInput,
  FlexPayInitiatePayoutResult,
} from './flexpay.service';
import {
  assertPayoutUrl,
  getPayoutFailureMessage,
  getPayoutHttpRejection,
  normalizePayoutPhone,
  PAYOUT_MESSAGES,
} from './payout-policy';

/** FlexPaie Payout v1.03: separate credentials and contract from collections. */
export class FlexPayPayoutClient {
  private readonly logger = new Logger(FlexPayPayoutClient.name);
  private token: { value: string; expiresAt: number } | null = null;
  private authentication: Promise<string> | null = null;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async initiate(
    input: FlexPayInitiatePayoutInput,
  ): Promise<FlexPayInitiatePayoutResult> {
    const url = this.getServiceUrl();
    const currency = input.currency?.trim().toUpperCase();
    if (
      !input.phone?.trim() ||
      !Number.isFinite(input.amount) ||
      input.amount <= 0 ||
      !['CDF', 'USD'].includes(currency) ||
      !input.description?.trim() ||
      !input.reference?.trim()
    ) {
      throw new BadRequestException(
        'Les paramètres du versement sont invalides',
      );
    }
    const body = {
      merchant: this.getMerchant(),
      type: '1',
      reference: input.reference,
      amount: Number.isInteger(input.amount)
        ? String(input.amount)
        : input.amount.toFixed(2),
      currency,
      customer: normalizePayoutPhone(input.phone).slice(1),
      description: input.description,
      callback_url: assertPayoutUrl(
        input.callbackUrl,
        this.optional('NODE_ENV') === 'production',
      ),
    };
    // An auth failure is safe to release: /pay has not been called yet.
    const authorization = await this.getToken();
    this.logger.log(
      `FlexPaie payout request: reference=${input.reference}, amount=${body.amount} ${currency}`,
    );
    try {
      const response = await firstValueFrom(
        this.http.post<unknown>(url, body, {
          ...this.requestOptions(),
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        }),
      );
      const raw = this.record(response.data);
      const code = this.string(raw, 'code') ?? '';
      // The example on page 8 uses OXX0, while the table uses 0XX0.
      const status =
        this.string(raw, 'status')?.toUpperCase().replace(/^OXX/, '0XX') ??
        null;
      const orderNumber = this.string(raw, 'orderNumber');
      const accepted = code === '0' && status === '0XX0' && !!orderNumber;
      const rejected =
        code === '1' &&
        (status === null || ['0XX2', '0XX3', '0XX4', '0XX5'].includes(status));
      if (status === '0XX4') this.token = null;
      const message = rejected
        ? getPayoutFailureMessage(this.string(raw, 'message'), status)
        : this.string(raw, 'message');
      this.logger.log(
        `FlexPaie payout acknowledgement: reference=${input.reference}, code=${code}, status=${status}, orderNumber=${orderNumber ?? 'none'}`,
      );
      return {
        code,
        status,
        orderNumber,
        message,
        paymentUrl: null,
        pending: !accepted && !rejected,
        raw,
      };
    } catch (error) {
      this.invalidateRejectedToken(error);
      // Never replay /pay after a timeout or a rejected/expired token.
      const rejection = getPayoutHttpRejection(error);
      if (rejection) throw rejection;
      this.logger.warn(
        `FlexPaie payout acknowledgement unavailable: reference=${input.reference}`,
      );
      throw new BadGatewayException(PAYOUT_MESSAGES.pending);
    }
  }

  async checkTransaction(
    orderNumber: string,
  ): Promise<FlexPayCheckTransactionResult> {
    if (!orderNumber?.trim())
      throw new BadRequestException('Le numéro de commande FlexPay est requis');
    const url = this.resourceUrl(
      'FLEXPAY_PAYOUT_CHECK_TRANSACTION_URL',
      '/api/rest/v1/check',
      'orderNumber',
      orderNumber.trim(),
    );
    const raw = await this.get(url);
    const status = this.string(raw, 'status');
    // A flat "transaction not found" response is not a failed transfer.
    const transaction =
      this.string(raw, 'reference') &&
      this.string(raw, 'orderNumber') &&
      status !== null
        ? {
            orderNumber: this.string(raw, 'orderNumber'),
            reference: this.string(raw, 'reference'),
            providerReference: this.string(raw, 'providerReference'),
            code: this.string(raw, 'code'),
            status,
            amount: this.string(raw, 'amount'),
            amountCustomer: this.string(raw, 'amountCustomer'),
            currency: this.string(raw, 'currency'),
            createdAt: this.string(raw, 'created_at'),
          }
        : null;
    return {
      code: this.string(raw, 'code') ?? '',
      message: this.string(raw, 'message'),
      transaction,
      raw,
    };
  }

  /** Internal diagnostic only; no public route exposing the merchant balance. */
  async checkBalance(): Promise<{
    balances: { currency: string; amount: string }[];
  }> {
    const url = this.resourceUrl(
      'FLEXPAY_PAYOUT_BALANCE_URL',
      '/api/rest/v1/balance',
      'merchant',
      this.getMerchant(),
    );
    const raw = await this.get(url);
    if (this.string(raw, 'code') !== '0' || !Array.isArray(raw.balances)) {
      throw new BadGatewayException(PAYOUT_MESSAGES.configuration);
    }
    const balances = raw.balances.map((entry: unknown) => {
      const item = this.record(entry);
      const currency = this.string(item, 'currency');
      const amount = this.string(item, 'amount');
      if (
        !currency ||
        !['CDF', 'USD'].includes(currency) ||
        !amount ||
        !Number.isFinite(Number(amount)) ||
        Number(amount) < 0
      ) {
        throw new BadGatewayException(PAYOUT_MESSAGES.configuration);
      }
      return { currency, amount };
    });
    return { balances };
  }

  private async get(url: string): Promise<Record<string, unknown>> {
    const authorization = await this.getToken();
    try {
      const response = await firstValueFrom(
        this.http.get<unknown>(url, {
          ...this.requestOptions(),
          headers: { Authorization: authorization, Accept: 'application/json' },
        }),
      );
      return this.record(response.data);
    } catch (error) {
      this.invalidateRejectedToken(error);
      throw new BadGatewayException(PAYOUT_MESSAGES.pending);
    }
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt)
      return this.token.value;
    if (!this.authentication) this.authentication = this.authenticate();
    try {
      return await this.authentication;
    } finally {
      this.authentication = null;
    }
  }

  private async authenticate(): Promise<string> {
    try {
      const url = this.validateEndpoint(
        this.optional('FLEXPAY_PAYOUT_AUTH_URL') ||
          new URL('/api/v1/auth/authenticate', this.getServiceUrl()).toString(),
      );
      const username = this.optional('FLEXPAY_PAYOUT_USERNAME');
      // Do not trim a password: whitespace can be part of the credential.
      const password = this.config.get<string>('FLEXPAY_PAYOUT_PASSWORD');
      if (!username || !password) throw new Error('Missing payout credentials');
      const startedAt = Date.now();
      const response = await firstValueFrom(
        this.http.post<unknown>(
          url,
          { username, password },
          {
            ...this.requestOptions(),
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
          },
        ),
      );
      const raw = this.record(response.data);
      const token = this.string(raw, 'token')
        ?.replace(/^Bearer\s+/i, '')
        .trim();
      const lifetime = Number(raw.expire_in) * 1000;
      const expiresAt = startedAt + lifetime - Math.min(30000, lifetime * 0.1);
      if (
        this.string(raw, 'code') !== '0' ||
        !token ||
        /^Bearer$/i.test(token) ||
        /\s/.test(token) ||
        !Number.isFinite(lifetime) ||
        lifetime <= 0 ||
        expiresAt <= Date.now()
      ) {
        throw new Error('Invalid payout authentication response');
      }
      this.token = { value: `Bearer ${token}`, expiresAt };
      return this.token.value;
    } catch {
      this.token = null;
      // Never log credentials, the auth response or an Axios request body.
      this.logger.warn(
        'FlexPaie payout authentication unavailable; no transfer submitted',
      );
      throw new BadRequestException({
        code: 'PAYOUT_SERVICE_UNAVAILABLE',
        message: PAYOUT_MESSAGES.configuration,
      });
    }
  }

  private invalidateRejectedToken(error: unknown): void {
    if (isAxiosError(error) && [401, 403].includes(error.response?.status ?? 0))
      this.token = null;
  }

  private getServiceUrl(): string {
    // The PDF leaves host and version unspecified. Never infer them from collections.
    const url = this.optional('FLEXPAY_PAYOUT_SERVICE_URL');
    return assertPayoutUrl(url ?? '', true, true);
  }

  private resourceUrl(
    key: string,
    path: string,
    placeholder: string,
    value: string,
  ): string {
    const configured = this.optional(key);
    const encoded = encodeURIComponent(value);
    const url = configured
      ? configured.includes(`{${placeholder}}`)
        ? configured.replace(`{${placeholder}}`, encoded)
        : `${configured.replace(/\/+$/, '')}/${encoded}`
      : new URL(`${path}/${encoded}`, this.getServiceUrl()).toString();
    return this.validateEndpoint(url);
  }

  private validateEndpoint(url: string): string {
    return assertPayoutUrl(url, true);
  }

  private getMerchant(): string {
    const merchant =
      this.optional('FLEXPAY_PAYOUT_MERCHANT_CODE') ||
      this.optional('FLEXPAY_MERCHANT_CODE') ||
      this.optional('FLEXPAY_MERCHANT');
    if (!merchant)
      throw new BadRequestException({
        code: 'PAYOUT_SERVICE_UNAVAILABLE',
        message: PAYOUT_MESSAGES.configuration,
      });
    return merchant;
  }

  private requestOptions() {
    const timeout = Number(
      this.config.get<string | number>('FLEXPAY_REQUEST_TIMEOUT_MS'),
    );
    return {
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000,
      maxRedirects: 0,
    };
  }

  private optional(key: string): string | null {
    return this.config.get<string>(key)?.trim() || null;
  }

  private record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private string(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' || typeof value === 'number'
      ? String(value).trim() || null
      : null;
  }
}
