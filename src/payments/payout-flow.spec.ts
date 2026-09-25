import { BadRequestException, Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { FlexPayService } from './flexpay.service';
import { PaymentsService } from './payments.service';
import { normalizePayoutPhone, PAYOUT_MESSAGES } from './payout-policy';
import { PaymentStatus } from './entities/payment-transaction.entity';

describe('Merchant-to-driver payouts (no real network or database)', () => {
  let config: Record<string, string>;
  let http: { post: jest.Mock; get: jest.Mock };
  let repository: { create: jest.Mock; save: jest.Mock };
  let flexpay: FlexPayService;
  let service: PaymentsService;
  const input = {
    userId: 'driver-test',
    purpose: 'driver_payout',
    phone: '0891234567',
    amount: 9500,
    currency: 'CDF',
    description: 'Versement de gains',
    callbackUrl:
      'https://example.invalid/api/v1/driver-settlements/payouts/flexpay/callback',
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    config = {
      FLEXPAY_TOKEN: 'collection-token',
      FLEXPAY_MERCHANT_CODE: 'ZWANGA_TEST',
      FLEXPAY_PAYOUT_SERVICE_URL: 'https://payout.example.invalid/v1/pay',
      FLEXPAY_PAYOUT_USERNAME: 'payout-user',
      FLEXPAY_PAYOUT_PASSWORD: 'payout-password',
    };
    const configuration = { get: (key: string) => config[key] };
    http = {
      post: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: { code: '0', token: 'dummy-zwanga-token', expire_in: 1234 },
          }),
        )
        .mockReturnValue(
          of({
            data: { code: '0', status: '0XX0', orderNumber: 'TEST_ORDER' },
          }),
        ),
      get: jest.fn(),
    };
    repository = {
      create: jest.fn((value) => ({ ...value })),
      save: jest.fn(async (value) => ({ ...value, id: 'payment-test' })),
    };
    flexpay = new FlexPayService(http as any, configuration as any);
    service = new PaymentsService(
      repository as any,
      configuration as any,
      flexpay,
      { isConfigured: () => false } as any,
      { register: jest.fn(), apply: jest.fn() } as any,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    '0891234567',
    '243891234567',
    '+243891234567',
    '00243891234567',
    '891234567',
    '+243 891 234 567',
  ])('accepts and normalizes receiver %s', async (phone) => {
    expect(normalizePayoutPhone(phone)).toBe('+243891234567');
    const result = await service.initiatePayout({ ...input, phone });
    expect(result.status).toBe(PaymentStatus.INITIATED);
    expect(http.post).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/pay$/),
      expect.objectContaining({
        merchant: 'ZWANGA_TEST',
        type: '1',
        customer: '243891234567',
        amount: '9500',
        currency: 'CDF',
        description: input.description,
        callback_url: input.callbackUrl,
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer dummy-zwanga-token',
        }),
      }),
    );
  });

  it.each([
    '',
    '123',
    '+33123456789',
    'phone0891234567',
    '089123456789',
    '+0891234567',
  ])('rejects invalid receiver before calling FlexPay: %s', async (phone) => {
    await expect(
      service.initiatePayout({ ...input, phone }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 405, 422])(
    'treats explicit provider HTTP %s rejection as failed',
    async (status) => {
      http.post.mockReturnValue(
        throwError(() =>
          Object.assign(new Error('Mock HTTP error'), {
            isAxiosError: true,
            response: {
              status,
              data: { message: 'Technical provider refusal' },
            },
          }),
        ),
      );
      await expect(service.initiatePayout(input)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: PaymentStatus.FAILED }),
      );
    },
  );

  it.each([408, 429, 500, 502, 503, undefined])(
    'keeps ambiguous HTTP %s reserved',
    async (status) => {
      http.post.mockReturnValue(
        throwError(() =>
          Object.assign(new Error('Mock network error'), {
            isAxiosError: true,
            response: status ? { status } : undefined,
          }),
        ),
      );
      const result = await service.initiatePayout(input);
      expect(result.status).toBe(PaymentStatus.PENDING);
      expect(result.orderNumber).toBeNull();
      expect(service.getClientPaymentMessage(result)).toBe(
        PAYOUT_MESSAGES.review,
      );
    },
  );

  it('does not announce successful transfer for initial code zero', async () => {
    const result = await service.initiatePayout(input);
    expect(result.status).toBe(PaymentStatus.INITIATED);
    expect(service.getClientPaymentMessage(result)).toBe(
      PAYOUT_MESSAGES.pending,
    );
  });

  it('keeps a malformed acknowledgement uncertain', async () => {
    http.post.mockReturnValue(of({ data: {} }));
    expect((await service.initiatePayout(input)).status).toBe(
      PaymentStatus.PENDING,
    );
  });

  it('does not ask the driver to replenish their balance when the merchant lacks funds', async () => {
    http.post.mockReturnValue(
      of({ data: { code: '1', message: 'Insufficient merchant balance' } }),
    );
    await expect(service.initiatePayout(input)).rejects.toThrow(
      PAYOUT_MESSAGES.funds,
    );
    expect(repository.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: PaymentStatus.FAILED,
        providerMessage: PAYOUT_MESSAGES.funds,
      }),
    );
  });

  it('also explains a merchant balance refusal returned as HTTP 400', async () => {
    http.post.mockReturnValue(
      throwError(() =>
        Object.assign(new Error('Mock refusal'), {
          isAxiosError: true,
          response: {
            status: 400,
            data: { message: 'Insufficient merchant balance' },
          },
        }),
      ),
    );
    await expect(service.initiatePayout(input)).rejects.toThrow(
      PAYOUT_MESSAGES.funds,
    );
    expect(repository.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: PaymentStatus.FAILED }),
    );
  });

  it('never marks money available after an accepted transfer followed by a persistence error', async () => {
    repository.save
      .mockImplementationOnce(async (value) => ({
        ...value,
        id: 'payment-test',
      }))
      .mockRejectedValueOnce(new Error('Mock persistence outage'));
    const result = await service.initiatePayout(input);
    expect(result.status).toBe(PaymentStatus.PENDING);
    expect(result.orderNumber).toBe('TEST_ORDER');
    expect(repository.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: PaymentStatus.PENDING }),
    );
  });

  it.each([
    { NODE_ENV: 'production', FLEXPAY_PAYOUT_SERVICE_URL: '' },
    {
      FLEXPAY_PAYOUT_SERVICE_URL:
        'https://example.invalid/api/rest/v1/paymentService',
    },
    {
      FLEXPAY_PAYOUT_SERVICE_URL:
        'https://example.invalid/api/rest/v1/merchantPayOutService',
    },
    {
      NODE_ENV: 'production',
      FLEXPAY_PAYOUT_SERVICE_URL: 'http://example.invalid/v1/pay',
    },
  ])(
    'blocks unsafe or missing payout endpoint configuration',
    async (values) => {
      Object.assign(config, values);
      await expect(service.initiatePayout(input)).rejects.toThrow(
        PAYOUT_MESSAGES.configuration,
      );
      expect(http.post).not.toHaveBeenCalled();
    },
  );

  it('uses the configured production merchant payout URL and callback', async () => {
    config.NODE_ENV = 'production';
    config.FLEXPAY_PAYOUT_SERVICE_URL = 'https://example.invalid/v1/pay';
    await service.initiatePayout(input);
    expect(http.post).toHaveBeenCalledWith(
      config.FLEXPAY_PAYOUT_SERVICE_URL,
      expect.objectContaining({ callback_url: input.callbackUrl }),
      expect.anything(),
    );
  });

  it('rejects a local callback in production before transfer', async () => {
    config.NODE_ENV = 'production';
    config.FLEXPAY_MOBILE_BASE_URL = 'https://example.invalid';
    await expect(
      service.initiatePayout({
        ...input,
        callbackUrl: 'http://localhost:5200/api/v1/callback',
      }),
    ).rejects.toThrow(PAYOUT_MESSAGES.configuration);
    expect(http.post).not.toHaveBeenCalled();
  });
});
