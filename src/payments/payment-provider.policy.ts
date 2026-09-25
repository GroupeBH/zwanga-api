import {
  BadGatewayException,
  BadRequestException,
  HttpException,
} from '@nestjs/common';
import {
  PaymentMethod,
  PaymentProvider,
} from './entities/payment-transaction.entity';

export const PAWAPAY_RETRYABLE_FAILURE_CODES = new Set([
  'PROVIDER_TEMPORARILY_UNAVAILABLE',
  'DEPOSITS_NOT_ALLOWED',
  'PAYOUTS_NOT_ALLOWED',
  'INVALID_PROVIDER',
  'AUTHENTICATION_ERROR',
  'AUTHORISATION_ERROR',
  'NO_AUTHENTICATION',
]);

export class PaymentGatewayUnavailableError extends BadGatewayException {
  readonly provider: PaymentProvider;
  readonly retryable: boolean;
  readonly uncertainDelivery: boolean;

  constructor(
    provider: PaymentProvider,
    message: string,
    options?: { retryable?: boolean; uncertainDelivery?: boolean },
  ) {
    super(message);
    this.name = 'PaymentGatewayUnavailableError';
    this.provider = provider;
    this.retryable = options?.retryable ?? false;
    this.uncertainDelivery = options?.uncertainDelivery ?? false;
  }
}

export function parsePaymentProvider(
  value?: string | null,
): PaymentProvider | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === PaymentProvider.FLEXPAY) {
    return PaymentProvider.FLEXPAY;
  }
  if (normalized === PaymentProvider.PAWAPAY) {
    return PaymentProvider.PAWAPAY;
  }
  return null;
}

export function parseEnabledPaymentProviders(
  value?: string | null,
): PaymentProvider[] {
  if (!value?.trim()) {
    return [PaymentProvider.FLEXPAY, PaymentProvider.PAWAPAY];
  }

  const parsed = value
    .split(',')
    .map((item) => parsePaymentProvider(item))
    .filter((item): item is PaymentProvider => item != null);

  return [...new Set(parsed)];
}

export function resolvePaymentProviders(options: {
  method: PaymentMethod;
  preferred?: PaymentProvider | null;
  primary?: PaymentProvider | null;
  enabled: PaymentProvider[];
  pawaPayConfigured: boolean;
}): PaymentProvider[] {
  const available = options.enabled.filter((provider) => {
    if (provider === PaymentProvider.PAWAPAY) {
      return options.pawaPayConfigured && options.method !== PaymentMethod.CARD;
    }
    return true;
  });

  if (options.method === PaymentMethod.CARD) {
    return available.filter((provider) => provider === PaymentProvider.FLEXPAY);
  }

  const ordered: PaymentProvider[] = [];
  const push = (provider?: PaymentProvider | null) => {
    if (
      provider &&
      available.includes(provider) &&
      !ordered.includes(provider)
    ) {
      ordered.push(provider);
    }
  };

  push(options.preferred);
  push(options.primary ?? PaymentProvider.FLEXPAY);
  for (const provider of available) {
    push(provider);
  }

  return ordered;
}

export function isUncertainProviderDelivery(error: unknown): boolean {
  if (error instanceof PaymentGatewayUnavailableError) {
    return error.uncertainDelivery;
  }
  // A gateway failure is not proof that a financial POST was rejected.
  if (!(error instanceof HttpException) || error.getStatus() >= 500)
    return true;

  const message = getErrorText(error).toLowerCase();
  return (
    message.includes('délai dépassé') ||
    message.includes('delai depasse') ||
    message.includes('timeout') ||
    message.includes('econnaborted')
  );
}

export function canFailoverPaymentProvider(error: unknown): boolean {
  if (error instanceof PaymentGatewayUnavailableError) {
    return error.retryable && !error.uncertainDelivery;
  }

  if (isUncertainProviderDelivery(error)) {
    return false;
  }

  return false;
}

function getErrorText(error: unknown): string {
  if (
    error instanceof BadRequestException ||
    error instanceof BadGatewayException
  ) {
    const response = error.getResponse();
    if (typeof response === 'string') {
      return response;
    }
    if (
      response &&
      typeof response === 'object' &&
      'message' in response &&
      (typeof response.message === 'string' || Array.isArray(response.message))
    ) {
      return Array.isArray(response.message)
        ? response.message.join(' ')
        : response.message;
    }
  }

  return error instanceof Error ? error.message : String(error ?? '');
}
