import { BadGatewayException, BadRequestException } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentProvider,
} from './entities/payment-transaction.entity';
import {
  canFailoverPaymentProvider,
  PaymentGatewayUnavailableError,
  parseEnabledPaymentProviders,
  resolvePaymentProviders,
} from './payment-provider.policy';
import {
  formatPawaPayAmount,
  predictPawaPayProvider,
  toPawaPayMsisdn,
} from './pawapay-msisdn';

describe('payment provider routing', () => {
  const enabled = [PaymentProvider.FLEXPAY, PaymentProvider.PAWAPAY];

  it('keeps FlexPay first and PawaPay as the mobile-money fallback', () => {
    expect(
      resolvePaymentProviders({
        method: PaymentMethod.MOBILE_MONEY,
        enabled,
        pawaPayConfigured: true,
      }),
    ).toEqual([PaymentProvider.FLEXPAY, PaymentProvider.PAWAPAY]);
  });

  it('honours an explicit PawaPay preference before FlexPay', () => {
    expect(
      resolvePaymentProviders({
        method: PaymentMethod.MOBILE_MONEY,
        preferred: PaymentProvider.PAWAPAY,
        enabled,
        pawaPayConfigured: true,
      }),
    ).toEqual([PaymentProvider.PAWAPAY, PaymentProvider.FLEXPAY]);
  });

  it('keeps card payments on FlexPay', () => {
    expect(
      resolvePaymentProviders({
        method: PaymentMethod.CARD,
        preferred: PaymentProvider.PAWAPAY,
        enabled,
        pawaPayConfigured: true,
      }),
    ).toEqual([PaymentProvider.FLEXPAY]);
  });

  it('skips PawaPay until an API token is configured', () => {
    expect(
      resolvePaymentProviders({
        method: PaymentMethod.MOBILE_MONEY,
        enabled,
        pawaPayConfigured: false,
      }),
    ).toEqual([PaymentProvider.FLEXPAY]);
  });

  it('parses the enabled provider list', () => {
    expect(parseEnabledPaymentProviders('pawapay, flexpay, unknown')).toEqual([
      PaymentProvider.PAWAPAY,
      PaymentProvider.FLEXPAY,
    ]);
  });

  it('fails over only after a proven pre-processing rejection, not an outage', () => {
    expect(
      canFailoverPaymentProvider(
        new BadGatewayException('FlexPay indisponible'),
      ),
    ).toBe(false);
    expect(
      canFailoverPaymentProvider(
        new PaymentGatewayUnavailableError(
          PaymentProvider.PAWAPAY,
          'REJECTED',
          { retryable: true },
        ),
      ),
    ).toBe(true);
    expect(parseEnabledPaymentProviders('unknown')).toEqual([]);
    expect(
      canFailoverPaymentProvider(
        new BadRequestException(
          'Le numéro de téléphone doit commencer par +243',
        ),
      ),
    ).toBe(false);
    expect(
      canFailoverPaymentProvider(new Error('délai dépassé après 30000ms')),
    ).toBe(false);
  });
});

describe('PawaPay phone routing', () => {
  it.each([
    ['+243891234567', '243891234567', 'ORANGE_COD'],
    ['0811234567', '243811234567', 'VODACOM_MPESA_COD'],
    ['+243971234567', '243971234567', 'AIRTEL_COD'],
  ])('normalizes %s', (phone, msisdn, provider) => {
    expect(toPawaPayMsisdn(phone)).toBe(msisdn);
    expect(predictPawaPayProvider(phone)).toBe(provider);
  });

  it('preserves amounts and rejects unsupported Vodacom fractions without rounding', () => {
    expect(formatPawaPayAmount(1500.4, 'CDF', 'ORANGE_COD')).toBe('1500.4');
    expect(formatPawaPayAmount(1500.4, 'CDF', 'AIRTEL_COD')).toBe('1500.4');
    expect(() =>
      formatPawaPayAmount(1500.4, 'CDF', 'VODACOM_MPESA_COD'),
    ).toThrow('entier');
    expect(formatPawaPayAmount(12.5, 'USD')).toBe('12.5');
    expect(() => formatPawaPayAmount(12.345, 'USD')).toThrow();
    expect(() => formatPawaPayAmount(NaN, 'CDF')).toThrow();
    expect(() => toPawaPayMsisdn('abc243891234567')).toThrow();
  });
});
