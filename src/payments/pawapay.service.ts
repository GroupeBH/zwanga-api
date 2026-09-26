import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { isAxiosError, type AxiosError } from 'axios';
import type { Request as ExpressRequest } from 'express';
import { formatPaymentLogPayload } from './payment-log.util';
import {
  PAWAPAY_RETRYABLE_FAILURE_CODES,
  PaymentGatewayUnavailableError,
} from './payment-provider.policy';
import { PaymentProvider } from './entities/payment-transaction.entity';
import { assertPawaPayId, parsePawaPaySnapshot } from './pawapay-snapshot';
import {
  formatPawaPayAmount,
  toPawaPayCustomerMessage,
  toPawaPayMsisdn,
} from './pawapay-msisdn';
import {
  pawaPayCallbackKeyId,
  signPawaPayRequest,
  verifyPawaPayCallback,
} from './pawapay-signature';

import type {
  NormalizedPawaPayCallback,
  PawaPayCallbackKind,
  PawaPayInitiateInput,
  PawaPayInitiateResult,
  PawaPayPaymentSnapshot,
} from './pawapay.types';
export type * from './pawapay.types';

@Injectable()
export class PawaPayService {
  private readonly logger = new Logger(PawaPayService.name);
  private readonly defaultSandboxUrl = 'https://api.sandbox.pawapay.io';
  private readonly defaultProductionUrl = 'https://api.pawapay.io';
  private readonly defaultTimeoutMs = 30000;
  private publicKeysCache: {
    until: number;
    keys: Array<{ id: string; key: string }>;
  } | null = null;
  private lastUnknownKeyRefreshAt = 0;
  private activeConfigurationCache: {
    until: number;
    value: Record<string, unknown>;
  } | null = null;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  isConfigured(): boolean {
    if (!this.getApiToken()) return false;
    const requireSigned =
      this.configService.get<string>('PAWAPAY_REQUIRE_SIGNED_REQUESTS') ===
        'true' || this.configService.get<string>('NODE_ENV') === 'production';
    return (
      !requireSigned ||
      Boolean(
        this.configService.get<string>('PAWAPAY_SIGNING_PRIVATE_KEY_BASE64') &&
        this.configService.get<string>('PAWAPAY_SIGNING_KEY_ID'),
      )
    );
  }

  async initiateDeposit(
    input: PawaPayInitiateInput,
  ): Promise<PawaPayInitiateResult> {
    return this.initiate('deposits', input);
  }

  async initiatePayout(
    input: PawaPayInitiateInput,
  ): Promise<PawaPayInitiateResult> {
    return this.initiate('payouts', input);
  }

  async checkDeposit(depositId: string): Promise<PawaPayPaymentSnapshot> {
    return this.check('deposits', depositId);
  }

  async checkPayout(payoutId: string): Promise<PawaPayPaymentSnapshot> {
    return this.check('payouts', payoutId);
  }

  async checkRefund(refundId: string): Promise<PawaPayPaymentSnapshot> {
    return this.check('refunds', refundId);
  }

  async getActiveConfiguration(): Promise<Record<string, unknown>> {
    if (
      this.activeConfigurationCache &&
      this.activeConfigurationCache.until > Date.now()
    ) {
      return this.activeConfigurationCache.value;
    }
    const value = await this.toolkitGet('active-conf');
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Array.isArray((value as Record<string, unknown>).countries)
    ) {
      throw new PaymentGatewayUnavailableError(
        PaymentProvider.PAWAPAY,
        'Configuration PawaPay invalide',
        { retryable: false },
      );
    }
    const configuration = value as Record<string, unknown>;
    this.activeConfigurationCache = {
      until: Date.now() + 300_000,
      value: configuration,
    };
    return configuration;
  }

  async getAvailability(): Promise<unknown> {
    return this.toolkitGet('availability');
  }

  async getWalletBalances(): Promise<unknown> {
    return this.toolkitGet('wallet-balances');
  }

  async predictProvider(
    phone: string,
  ): Promise<{ country: string; provider: string; phoneNumber: string }> {
    const msisdn = toPawaPayMsisdn(phone);
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          this.joinUrl(this.getBaseUrl(), 'v2', 'predict-provider'),
          { phoneNumber: msisdn },
          {
            headers: this.getHeaders(),
            timeout: this.getRequestTimeoutMs(),
            maxRedirects: 0,
          },
        ),
      );
      const data = response.data as Record<string, unknown>;
      if (
        data?.country !== 'COD' ||
        typeof data.provider !== 'string' ||
        typeof data.phoneNumber !== 'string' ||
        data.phoneNumber !== msisdn
      ) {
        throw new BadRequestException('Prédiction opérateur PawaPay invalide');
      }
      return data as { country: string; provider: string; phoneNumber: string };
    } catch (error) {
      this.handleHttpError(error, 'Prédiction opérateur PawaPay');
    }
  }

  async initiateRefund(input: {
    refundId: string;
    depositId: string;
    amount: number;
    currency: string;
    clientReferenceId: string;
  }): Promise<PawaPayInitiateResult> {
    assertPawaPayId(input.refundId);
    assertPawaPayId(input.depositId);
    if (!this.isConfigured()) {
      throw new PaymentGatewayUnavailableError(
        PaymentProvider.PAWAPAY,
        'PawaPay non configuré',
        { retryable: true },
      );
    }
    const body = {
      refundId: input.refundId,
      depositId: input.depositId,
      amount: formatPawaPayAmount(input.amount, input.currency),
      currency: input.currency.toUpperCase(),
      clientReferenceId: input.clientReferenceId.slice(0, 36),
    };
    const url = this.joinUrl(this.getBaseUrl(), 'v2', 'refunds');
    try {
      const response = await this.financialPost(url, body);
      const snapshot = this.readResponse(
        response,
        'refunds',
        input.refundId,
        true,
      );
      return {
        paymentId: snapshot.paymentId,
        status: snapshot.status,
        accepted: this.isAccepted(snapshot.status),
        paymentUrl: null,
        failureCode: snapshot.failureCode,
        failureMessage: snapshot.failureMessage,
        raw: snapshot.raw,
      };
    } catch (error) {
      this.handleHttpError(error, 'Initialisation remboursement PawaPay');
    }
  }

  async resendCallback(
    kind: PawaPayCallbackKind,
    paymentId: string,
  ): Promise<unknown> {
    return this.operationPost(kind, 'resend-callback', paymentId);
  }

  async failEnqueued(
    kind: 'payouts' | 'refunds',
    paymentId: string,
  ): Promise<unknown> {
    return this.operationPost(kind, 'fail-enqueued', paymentId);
  }

  async verifyCallbackRequest(
    request: RawBodyRequest<ExpressRequest>,
  ): Promise<void> {
    const configured = this.configService.get<string>(
      'PAWAPAY_REQUIRE_SIGNED_CALLBACKS',
    );
    const required =
      configured === 'true' ||
      this.configService.get<string>('NODE_ENV') === 'production';
    if (!required) return;
    if (!request.rawBody)
      throw new BadRequestException('Corps brut du callback PawaPay absent');
    const keyId = pawaPayCallbackKeyId(request.headers);
    const hadCachedKeys = Boolean(
      this.publicKeysCache && this.publicKeysCache.until > Date.now(),
    );
    let keys = await this.getPublicKeys();
    let publicKey = keys.find((entry) => entry.id === keyId)?.key;
    if (
      !publicKey &&
      hadCachedKeys &&
      Date.now() - this.lastUnknownKeyRefreshAt > 60_000
    ) {
      this.lastUnknownKeyRefreshAt = Date.now();
      this.publicKeysCache = null;
      keys = await this.getPublicKeys();
      publicKey = keys.find((entry) => entry.id === keyId)?.key;
    }
    if (!publicKey)
      throw new UnauthorizedException('Clé publique PawaPay inconnue');
    const host = request.headers.host;
    if (!host) throw new BadRequestException('Hôte du callback PawaPay absent');
    verifyPawaPayCallback({
      method: request.method,
      url: new URL(request.originalUrl, `https://${host}`).toString(),
      headers: request.headers,
      body: request.rawBody,
      publicKeyPem: publicKey,
    });
  }

  private async getPublicKeys(): Promise<Array<{ id: string; key: string }>> {
    if (this.publicKeysCache && this.publicKeysCache.until > Date.now())
      return this.publicKeysCache.keys;
    const data = await this.toolkitGet('public-key/http');
    if (
      !Array.isArray(data) ||
      !data.every(
        (entry: unknown) =>
          entry &&
          typeof entry === 'object' &&
          typeof (entry as Record<string, unknown>).id === 'string' &&
          typeof (entry as Record<string, unknown>).key === 'string',
      )
    ) {
      throw new PaymentGatewayUnavailableError(
        PaymentProvider.PAWAPAY,
        'Clés publiques PawaPay invalides',
        { retryable: false },
      );
    }
    const keys = data as Array<{ id: string; key: string }>;
    this.publicKeysCache = { until: Date.now() + 600_000, keys };
    return keys;
  }

  private async toolkitGet(path: string): Promise<unknown> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(this.joinUrl(this.getBaseUrl(), 'v2', path), {
          headers: this.getHeaders(),
          timeout: this.getRequestTimeoutMs(),
          maxRedirects: 0,
        }),
      );
      return response.data;
    } catch (error) {
      this.handleHttpError(error, `Lecture ${path} PawaPay`);
    }
  }

  private async operationPost(
    kind: PawaPayCallbackKind,
    operation: string,
    paymentId: string,
  ): Promise<unknown> {
    assertPawaPayId(paymentId);
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          this.joinUrl(this.getBaseUrl(), 'v2', kind, operation, paymentId),
          undefined,
          {
            headers: this.getHeaders(),
            timeout: this.getRequestTimeoutMs(),
            maxRedirects: 0,
          },
        ),
      );
      const data = response.data as Record<string, unknown>;
      const idKey =
        kind === 'deposits'
          ? 'depositId'
          : kind === 'payouts'
            ? 'payoutId'
            : 'refundId';
      if (
        !data ||
        data[idKey] !== paymentId ||
        !['ACCEPTED', 'REJECTED'].includes(String(data.status))
      ) {
        throw new PaymentGatewayUnavailableError(
          PaymentProvider.PAWAPAY,
          'Réponse de l’opération PawaPay non vérifiable',
          { retryable: false, uncertainDelivery: true },
        );
      }
      if (data.status === 'REJECTED') {
        const failure = data.failureReason as
          Record<string, unknown> | undefined;
        throw new BadRequestException(
          typeof failure?.failureMessage === 'string'
            ? failure.failureMessage
            : 'Opération PawaPay refusée',
        );
      }
      return data;
    } catch (error) {
      this.handleHttpError(error, `${operation} ${kind} PawaPay`);
    }
  }

  private async financialPost(
    url: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const bodyJson = JSON.stringify(body);
    const headers = this.getHeaders();
    const privateKey = this.configService.get<string>(
      'PAWAPAY_SIGNING_PRIVATE_KEY_BASE64',
    );
    const keyId = this.configService.get<string>('PAWAPAY_SIGNING_KEY_ID');
    const requireSigned =
      this.configService.get<string>('PAWAPAY_REQUIRE_SIGNED_REQUESTS') ===
        'true' || this.configService.get<string>('NODE_ENV') === 'production';
    if (privateKey && keyId) {
      Object.assign(
        headers,
        signPawaPayRequest(
          url,
          bodyJson,
          Buffer.from(privateKey, 'base64').toString('utf8'),
          keyId,
        ),
      );
    } else if (requireSigned || privateKey || keyId) {
      throw new PaymentGatewayUnavailableError(
        PaymentProvider.PAWAPAY,
        'Signature des requêtes PawaPay non configurée',
        { retryable: true },
      );
    }
    const response = await firstValueFrom(
      this.httpService.post<Record<string, unknown>>(
        url,
        privateKey && keyId ? bodyJson : body,
        { headers, timeout: this.getRequestTimeoutMs(), maxRedirects: 0 },
      ),
    );
    return response.data;
  }

  isAccepted(status?: string | null): boolean {
    return ['ACCEPTED', 'DUPLICATE_IGNORED'].includes(
      String(status ?? '').toUpperCase(),
    );
  }

  isCompleted(status?: string | null): boolean {
    return String(status ?? '').toUpperCase() === 'COMPLETED';
  }

  isFailed(status?: string | null): boolean {
    return ['FAILED', 'REJECTED'].includes(String(status ?? '').toUpperCase());
  }

  isRetryableRejection(failureCode?: string | null): boolean {
    return PAWAPAY_RETRYABLE_FAILURE_CODES.has(
      String(failureCode ?? '').toUpperCase(),
    );
  }

  normalizeCallback(
    kind: PawaPayCallbackKind,
    payload: Record<string, unknown>,
  ): NormalizedPawaPayCallback {
    const snapshot = parsePawaPaySnapshot(payload, kind);
    if (!snapshot.paymentId) {
      throw new BadRequestException(
        'Le callback PawaPay doit contenir un identifiant de paiement',
      );
    }

    return {
      kind,
      paymentId: snapshot.paymentId,
      status: snapshot.status,
      amount: snapshot.amount,
      currency: snapshot.currency,
      clientReferenceId: snapshot.clientReferenceId,
      providerTransactionId: snapshot.providerTransactionId,
      paymentUrl: snapshot.paymentUrl,
      failureCode: snapshot.failureCode,
      failureMessage: snapshot.failureMessage,
      raw: snapshot.raw,
    };
  }

  private async initiate(
    kind: 'deposits' | 'payouts',
    input: PawaPayInitiateInput,
  ): Promise<PawaPayInitiateResult> {
    assertPawaPayId(input.paymentId);
    if (!this.isConfigured()) {
      throw new PaymentGatewayUnavailableError(
        PaymentProvider.PAWAPAY,
        'PawaPay non configuré',
        { retryable: true },
      );
    }
    const msisdn = toPawaPayMsisdn(input.phone);
    let provider: string;
    try {
      provider =
        input.operator?.trim() || (await this.predictProvider(msisdn)).provider;
      await this.assertConfiguredOperation(
        provider,
        input.currency,
        input.amount,
        kind,
      );
    } catch (error) {
      // No financial POST has been made yet, so another configured gateway may be tried.
      throw new PaymentGatewayUnavailableError(
        PaymentProvider.PAWAPAY,
        error instanceof Error
          ? error.message
          : 'Préparation PawaPay indisponible',
        { retryable: true, uncertainDelivery: false },
      );
    }
    const partyKey = kind === 'deposits' ? 'payer' : 'recipient';
    const idKey = kind === 'deposits' ? 'depositId' : 'payoutId';
    const body = {
      [idKey]: input.paymentId,
      amount: formatPawaPayAmount(input.amount, input.currency, provider),
      currency: input.currency.toUpperCase(),
      clientReferenceId: input.clientReferenceId.slice(0, 36),
      customerMessage: toPawaPayCustomerMessage(input.description),
      [partyKey]: {
        type: 'MMO',
        accountDetails: {
          phoneNumber: msisdn,
          provider,
        },
      },
    };
    const url = this.joinUrl(this.getBaseUrl(), 'v2', kind);

    this.logger.log(
      `PawaPay ${kind} request: url=${url}, paymentId=${input.paymentId}, provider=${provider}, phone=${this.maskPhone(msisdn)}, amount=${body.amount} ${body.currency}`,
    );

    try {
      const response = await this.financialPost(url, body);
      const snapshot = this.readResponse(response, kind, input.paymentId, true);
      this.logger.log(
        `PawaPay ${kind} response: paymentId=${snapshot.paymentId || input.paymentId}, status=${snapshot.status}, failure=${snapshot.failureCode ?? 'none'}, response=${formatPaymentLogPayload(snapshot.raw)}`,
      );

      if (
        snapshot.status === 'REJECTED' &&
        this.isRetryableRejection(snapshot.failureCode)
      ) {
        throw new PaymentGatewayUnavailableError(
          PaymentProvider.PAWAPAY,
          snapshot.failureMessage || 'PawaPay est temporairement indisponible',
          { retryable: true },
        );
      }

      return {
        paymentId: snapshot.paymentId || input.paymentId,
        status: snapshot.status,
        accepted: this.isAccepted(snapshot.status),
        paymentUrl: snapshot.paymentUrl,
        failureCode: snapshot.failureCode,
        failureMessage: snapshot.failureMessage,
        raw: snapshot.raw,
      };
    } catch (error) {
      this.handleHttpError(error, `Initialisation ${kind} PawaPay`);
    }
  }

  private async assertConfiguredOperation(
    providerId: string,
    currencyCode: string,
    amount: number,
    kind: 'deposits' | 'payouts',
  ): Promise<void> {
    const configuration = await this.getActiveConfiguration();
    const countries = configuration.countries as Array<Record<string, unknown>>;
    const country = countries.find((entry) => entry.country === 'COD');
    const providers = Array.isArray(country?.providers)
      ? (country.providers as Array<Record<string, unknown>>)
      : [];
    const provider = providers.find((entry) => entry.provider === providerId);
    const currencies = Array.isArray(provider?.currencies)
      ? (provider.currencies as Array<Record<string, unknown>>)
      : [];
    const currency = currencies.find(
      (entry) => entry.currency === currencyCode.toUpperCase(),
    );
    const operations = Array.isArray(currency?.operationTypes)
      ? (currency.operationTypes as Array<Record<string, unknown>>)
      : [];
    const type = kind === 'deposits' ? 'DEPOSIT' : 'PAYOUT';
    const operation = operations.find(
      (entry) => entry.operationType === type || type in entry,
    );
    const details =
      operation && typeof operation[type] === 'object' && operation[type]
        ? (operation[type] as Record<string, unknown>)
        : operation;
    if (
      !details ||
      !['OPERATIONAL', 'DELAYED'].includes(String(details.status))
    ) {
      throw new BadRequestException(
        'Opérateur, devise ou opération PawaPay indisponible',
      );
    }
    const min = Number(details.minTransactionLimit);
    const max = Number(details.maxTransactionLimit);
    if (
      (Number.isFinite(min) && amount < min) ||
      (Number.isFinite(max) && amount > max)
    ) {
      throw new BadRequestException(
        'Montant hors des limites PawaPay pour cet opérateur',
      );
    }
    if (details.decimalsInAmount === 'NONE' && !Number.isInteger(amount)) {
      throw new BadRequestException(
        'Cet opérateur PawaPay exige un montant entier',
      );
    }
  }

  private async check(
    kind: PawaPayCallbackKind,
    paymentId: string,
  ): Promise<PawaPayPaymentSnapshot> {
    assertPawaPayId(paymentId);

    const url = this.joinUrl(this.getBaseUrl(), 'v2', kind, paymentId.trim());
    this.logger.log(
      `PawaPay ${kind} check: paymentId=${paymentId}, url=${url}`,
    );

    try {
      const response = await firstValueFrom(
        this.httpService.get<Record<string, unknown>>(url, {
          headers: this.getHeaders(),
          timeout: this.getRequestTimeoutMs(),
          maxRedirects: 0,
        }),
      );
      const snapshot = this.readResponse(response.data, kind, paymentId, false);
      this.logger.log(
        `PawaPay ${kind} check response: paymentId=${snapshot.paymentId || paymentId}, status=${snapshot.status}, response=${formatPaymentLogPayload(snapshot.raw)}`,
      );
      return snapshot;
    } catch (error) {
      this.handleHttpError(error, `Vérification ${kind} PawaPay`);
    }
  }

  private readResponse(
    payload: unknown,
    kind: PawaPayCallbackKind,
    paymentId: string,
    initiation: boolean,
  ): PawaPayPaymentSnapshot {
    try {
      const snapshot = parsePawaPaySnapshot(payload, kind);
      if (
        !initiation &&
        snapshot.status !== 'NOT_FOUND' &&
        snapshot.raw.status !== 'FOUND'
      )
        throw new Error();
      if (snapshot.status !== 'NOT_FOUND' && snapshot.paymentId !== paymentId)
        throw new Error();
      if (
        initiation &&
        !['ACCEPTED', 'REJECTED', 'DUPLICATE_IGNORED'].includes(snapshot.status)
      )
        throw new Error();
      return snapshot;
    } catch {
      // A malformed response does not prove the POST failed at the provider.
      throw new PaymentGatewayUnavailableError(
        PaymentProvider.PAWAPAY,
        'Réponse PawaPay non vérifiable. Vérifiez le statut avant de réessayer.',
        { retryable: false, uncertainDelivery: true },
      );
    }
  }

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.getApiToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private getApiToken(): string {
    return (
      this.configService.get<string>('PAWAPAY_API_TOKEN')?.trim() ||
      this.configService.get<string>('PAWAPAY_TOKEN')?.trim() ||
      ''
    );
  }

  private getBaseUrl(): string {
    const configured = this.configService
      .get<string>('PAWAPAY_API_BASE_URL')
      ?.trim();
    if (configured) {
      const parsed = new URL(configured);
      const isProduction =
        this.configService.get<string>('NODE_ENV') === 'production';
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== '/' ||
        parsed.search ||
        parsed.hash ||
        parsed.hostname !==
          (isProduction ? 'api.pawapay.io' : 'api.sandbox.pawapay.io')
      ) {
        throw new BadRequestException(
          'URL API PawaPay incompatible avec cet environnement',
        );
      }
      return configured.replace(/\/+$/, '');
    }

    const nodeEnv = this.configService
      .get<string>('NODE_ENV')
      ?.trim()
      .toLowerCase();
    return nodeEnv === 'production'
      ? this.defaultProductionUrl
      : this.defaultSandboxUrl;
  }

  private getRequestTimeoutMs(): number {
    const parsed = Number(
      this.configService.get<string | number>('PAWAPAY_REQUEST_TIMEOUT_MS'),
    );
    return Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, 30000)
      : this.defaultTimeoutMs;
  }

  private handleHttpError(error: unknown, context: string): never {
    if (
      error instanceof HttpException ||
      error instanceof PaymentGatewayUnavailableError
    ) {
      throw error;
    }

    const axiosError = isAxiosError(error)
      ? error
      : (new Error('Erreur réseau PawaPay') as AxiosError);
    const status = axiosError.response?.status ?? 'unknown';
    const code = axiosError.code ?? 'none';
    const publicReason = this.getPublicHttpErrorReason(axiosError);
    this.logger.error(
      `${context} failed: status=${status}, code=${code}, reason=${publicReason ?? 'none'}, response=${formatPaymentLogPayload(axiosError.response?.data ?? axiosError.message)}`,
    );

    // Only documented pre-processing/auth rejections permit another provider.
    const rejectedBeforeProcessing = [400, 401, 403, 404, 405, 415].includes(
      Number(status),
    );
    throw new PaymentGatewayUnavailableError(
      PaymentProvider.PAWAPAY,
      publicReason
        ? `${context} indisponible (${publicReason})`
        : `${context} indisponible`,
      {
        retryable: [401, 403].includes(Number(status)),
        uncertainDelivery: !rejectedBeforeProcessing,
      },
    );
  }

  private getPublicHttpErrorReason(error: AxiosError): string | null {
    const message = error.message?.toLowerCase() ?? '';
    if (error.code === 'ECONNABORTED' || message.includes('timeout')) {
      return 'délai dépassé';
    }
    if (error.code === 'ENOTFOUND') {
      return 'hote pawapay introuvable';
    }
    if (error.code === 'ECONNREFUSED') {
      return 'connexion refusee';
    }
    if (error.response?.status) {
      return `HTTP ${error.response.status}`;
    }
    return null;
  }

  private maskPhone(phone: string): string {
    if (phone.length <= 6) {
      return '***';
    }
    return `${phone.slice(0, 3)}***${phone.slice(-4)}`;
  }

  private joinUrl(...parts: string[]): string {
    return parts
      .map((part, index) =>
        index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, ''),
      )
      .filter(Boolean)
      .join('/');
  }
}
