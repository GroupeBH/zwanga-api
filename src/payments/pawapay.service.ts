import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { isAxiosError, type AxiosError } from 'axios';
import { formatPaymentLogPayload } from './payment-log.util';
import {
  PAWAPAY_RETRYABLE_FAILURE_CODES,
  PaymentGatewayUnavailableError,
} from './payment-provider.policy';
import { PaymentProvider } from './entities/payment-transaction.entity';
import { assertPawaPayId, parsePawaPaySnapshot } from './pawapay-snapshot';
import {
  formatPawaPayAmount,
  predictPawaPayProvider,
  toPawaPayCustomerMessage,
  toPawaPayMsisdn,
} from './pawapay-msisdn';

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

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.getApiToken());
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
    const provider = predictPawaPayProvider(
      msisdn,
      this.configService.get<string>('PAWAPAY_DEFAULT_PROVIDER'),
    );
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
      const response = await firstValueFrom(
        this.httpService.post<Record<string, unknown>>(url, body, {
          headers: this.getHeaders(),
          timeout: this.getRequestTimeoutMs(),
          maxRedirects: 0,
        }),
      );
      const snapshot = this.readResponse(
        response.data,
        kind,
        input.paymentId,
        true,
      );
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
