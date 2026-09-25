/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Jest asymmetric matchers are typed as any. */
import { BadRequestException, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Observable, Subject, of, throwError } from 'rxjs';
import { validate } from 'class-validator';
import { FlexPayService } from './flexpay.service';
import { PaymentsService } from './payments.service';
import {
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';
import { FlexPayCallbackDto } from './dto/payment.dto';
import { PAYOUT_MESSAGES } from './payout-policy';
import { formatPaymentLogPayload } from './payment-log.util';

describe('FlexPaie payout v1.03 (mocked HTTP)', () => {
  let config: Record<string, string>;
  let http: {
    post: jest.Mock<Observable<{ data: unknown }>, [string, ...unknown[]]>;
    get: jest.Mock<Observable<{ data: unknown }>, [string, ...unknown[]]>;
  };
  let repository: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  let flexpay: FlexPayService;
  let payments: PaymentsService;
  const input = {
    userId: 'driver-1',
    purpose: PaymentPurpose.DRIVER_PAYOUT,
    reference: 'DRV123',
    phone: '+243891234567',
    amount: 9500,
    currency: 'CDF',
    description: 'Gains conducteur',
    callbackUrl:
      'https://api.example.invalid/api/v1/driver-settlements/payouts/flexpay/callback',
  };
  const auth = { code: '0', token: 'Bearer dedicated-token', expire_in: 120 };
  const accepted = {
    code: '0',
    status: '0XX0',
    orderNumber: 'ORDER123',
    message: 'Success',
  };

  beforeEach(() => {
    for (const method of ['log', 'warn', 'error'] as const)
      jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined);
    config = {
      FLEXPAY_PAYOUT_SERVICE_URL: 'https://payout.example.invalid/v1/pay',
      FLEXPAY_PAYOUT_USERNAME: 'payout-user',
      FLEXPAY_PAYOUT_PASSWORD: ' password with spaces ',
      FLEXPAY_PAYOUT_MERCHANT_CODE: 'PAYOUT_MERCHANT',
      FLEXPAY_MERCHANT_CODE: 'COLLECTION_MERCHANT',
      FLEXPAY_TOKEN: 'collection-token',
      FLEXPAY_VERIFY_CALLBACKS: 'false', // Never disable verification for payouts.
    };
    http = {
      post: jest.fn((url: string) =>
        of({ data: url.endsWith('/authenticate') ? auth : accepted }),
      ),
      get: jest.fn(),
    };
    repository = {
      create: jest.fn((value: Partial<PaymentTransaction>) => ({ ...value })),
      save: jest.fn((value: Partial<PaymentTransaction>) =>
        Promise.resolve({ id: 'payment-1', ...value }),
      ),
      findOne: jest.fn(),
    };
    const configuration = { get: (key: string) => config[key] };
    flexpay = new FlexPayService(
      http as unknown as HttpService,
      configuration as unknown as ConfigService,
    );
    payments = new PaymentsService(
      repository as unknown as Repository<PaymentTransaction>,
      configuration as unknown as ConfigService,
      flexpay,
      { isConfigured: () => false } as never,
      { register: jest.fn(), apply: jest.fn() } as never,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  async function initiateAndCheck(
    data: Record<string, unknown>,
    purpose = PaymentPurpose.DRIVER_PAYOUT,
  ) {
    const payment = await payments.initiatePayout({ ...input, purpose });
    repository.findOne.mockResolvedValue(payment);
    http.get.mockReturnValue(
      of({
        data: {
          reference: payment.reference,
          orderNumber: payment.orderNumber,
          ...data,
        },
      }),
    );
    return payments.checkPaymentStatus('ORDER123', input.userId);
  }

  it('caches the dedicated token until expiry and preserves password whitespace', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000000);
    await flexpay.initiatePayout(input);
    await flexpay.initiatePayout({ ...input, reference: 'DRV124' });
    expect(
      http.post.mock.calls.filter(([url]) => url.endsWith('/authenticate')),
    ).toHaveLength(1);
    expect(http.post).toHaveBeenNthCalledWith(
      1,
      'https://payout.example.invalid/api/v1/auth/authenticate',
      { username: 'payout-user', password: ' password with spaces ' },
      expect.objectContaining({ maxRedirects: 0 }),
    );
    expect(http.post).toHaveBeenNthCalledWith(
      2,
      config.FLEXPAY_PAYOUT_SERVICE_URL,
      expect.objectContaining({
        merchant: 'PAYOUT_MERCHANT',
        customer: '243891234567',
        callback_url: input.callbackUrl,
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer dedicated-token',
        }),
      }),
    );
    now.mockReturnValue(1120001);
    await flexpay.initiatePayout({ ...input, reference: 'DRV125' });
    expect(
      http.post.mock.calls.filter(([url]) => url.endsWith('/authenticate')),
    ).toHaveLength(2);
  });

  it('shares one authentication request for concurrent operations', async () => {
    const response = new Subject<{ data: typeof auth }>();
    http.post.mockReturnValueOnce(response);
    const first = flexpay.initiatePayout(input);
    const second = flexpay.initiatePayout({ ...input, reference: 'DRV124' });
    expect(http.post).toHaveBeenCalledTimes(1);
    response.next({ data: auth });
    response.complete();
    await Promise.all([first, second]);
    expect(http.post).toHaveBeenCalledTimes(3);
  });

  it.each([
    'FLEXPAY_PAYOUT_USERNAME',
    'FLEXPAY_PAYOUT_PASSWORD',
    'FLEXPAY_PAYOUT_SERVICE_URL',
  ])(
    'does not fall back to collection credentials when %s is missing',
    async (key) => {
      delete config[key];
      await expect(payments.initiatePayout(input)).rejects.toThrow(
        PAYOUT_MESSAGES.configuration,
      );
      expect(http.post).not.toHaveBeenCalled();
      expect(repository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: PaymentStatus.FAILED }),
      );
    },
  );

  it.each([
    { code: '1' },
    { code: '0', token: 'secret', expire_in: 0 },
    { code: '0', token: 'Bearer', expire_in: 120 },
    { code: '0', token: 'secret' },
  ])(
    'does not submit a payout after an invalid authentication response',
    async (data) => {
      http.post.mockReturnValueOnce(of({ data }));
      await expect(payments.initiatePayout(input)).rejects.toThrow(
        PAYOUT_MESSAGES.configuration,
      );
      expect(http.post).toHaveBeenCalledTimes(1);
    },
  );

  it('releases an unsent reservation after an authentication timeout without logging secrets', async () => {
    http.post.mockReturnValueOnce(
      throwError(() => new Error('password=secret token=secret')),
    );
    await expect(payments.initiatePayout(input)).rejects.toThrow(
      PAYOUT_MESSAGES.configuration,
    );
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: PaymentStatus.FAILED }),
    );
    expect(
      JSON.stringify((Logger.prototype.warn as jest.Mock).mock.calls),
    ).not.toContain('password=secret');
  });

  it.each([
    ['0XX2', PAYOUT_MESSAGES.funds],
    ['0XX3', PAYOUT_MESSAGES.refused],
    ['0XX4', PAYOUT_MESSAGES.configuration],
    ['0XX5', PAYOUT_MESSAGES.refused],
  ])(
    'interprets documented rejection %s even with an unhelpful message',
    async (status, message) => {
      http.post
        .mockReturnValueOnce(of({ data: auth }))
        .mockReturnValueOnce(
          of({ data: { code: '1', status, message: 'Error' } }),
        );
      await expect(payments.initiatePayout(input)).rejects.toThrow(message);
      expect(repository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: PaymentStatus.FAILED,
          providerStatusCode: status,
        }),
      );
      expect(http.post).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { code: '1', status: '0XX1' },
    { code: '0', status: 'unknown' },
    { code: '0', status: '0XX2' },
    { code: '0' },
    {},
  ])(
    'keeps uncertain acknowledgements reserved, including provider busy',
    async (data) => {
      http.post
        .mockReturnValueOnce(of({ data: auth }))
        .mockReturnValueOnce(
          of({ data: { ...data, orderNumber: 'ORDER123' } }),
        );
      const payment = await payments.initiatePayout(input);
      expect(payment.status).toBe(PaymentStatus.PENDING);
      expect(payment.orderNumber).toBe('ORDER123');
      expect(http.post).toHaveBeenCalledTimes(2);
    },
  );

  it('accepts the OXX0 spelling used in the PDF example, without confirming delivery', async () => {
    http.post
      .mockReturnValueOnce(of({ data: auth }))
      .mockReturnValueOnce(of({ data: { ...accepted, status: 'OXX0' } }));
    expect((await payments.initiatePayout(input)).status).toBe(
      PaymentStatus.INITIATED,
    );
  });

  it('discards a refused token but never automatically repeats the money transfer', async () => {
    http.post
      .mockReturnValueOnce(of({ data: auth }))
      .mockReturnValueOnce(
        throwError(() => ({ isAxiosError: true, response: { status: 401 } })),
      );
    await expect(flexpay.initiatePayout(input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(http.post).toHaveBeenCalledTimes(2);
    await flexpay.initiatePayout({ ...input, reference: 'NEW_REFERENCE' });
    expect(
      http.post.mock.calls.filter(([url]) => url.endsWith('/authenticate')),
    ).toHaveLength(2);
  });

  it.each([PaymentPurpose.DRIVER_PAYOUT, PaymentPurpose.REFERRAL_PAYOUT])(
    'confirms %s with the flat payout check response, not the collection endpoint',
    async (purpose) => {
      const payment = await initiateAndCheck(
        {
          code: '0',
          status: '0',
          providerReference: 'OPERATOR123',
          created_at: '20/03/2024 17:30:45',
        },
        purpose,
      );
      expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
      expect(payment.providerReference).toBe('OPERATOR123');
      expect(payment.paidAt).toBeInstanceOf(Date);
      expect(http.get).toHaveBeenCalledWith(
        'https://payout.example.invalid/api/rest/v1/check/ORDER123',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer dedicated-token',
          }),
        }),
      );
    },
  );

  it('applies a flat failed transaction with top-level code 1', async () => {
    const payment = await initiateAndCheck({
      code: '1',
      status: '1',
      message: 'Failed',
    });
    expect(payment.status).toBe(PaymentStatus.FAILED);
  });

  it.each([
    { code: '1', message: 'Transaction non trouvée' },
    { code: '0', status: '2' },
    { code: '1', status: '0' },
  ])(
    'does not release funds for a missing or inconclusive transaction',
    async (data) => {
      expect((await initiateAndCheck(data)).status).toBe(
        PaymentStatus.INITIATED,
      );
    },
  );

  it.each([
    { reference: 'ANOTHER_REFERENCE' },
    { orderNumber: 'ANOTHER_ORDER' },
    { amount: '1' },
    { currency: 'USD' },
  ])('rejects a mismatched provider result', async (data) => {
    await expect(
      initiateAndCheck({ code: '0', status: '0', ...data }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: PaymentStatus.SUCCEEDED }),
    );
  });

  it('verifies the complete v1.03 callback even when generic verification is disabled', async () => {
    const payment = await payments.initiatePayout(input);
    repository.findOne.mockResolvedValue(payment);
    const callback = Object.assign(new FlexPayCallbackDto(), {
      code: '0',
      reference: payment.reference,
      orderNumber: payment.orderNumber,
      providerReference: 'OP123',
      message: 'Success',
      status: '0',
      created_at: '20/03/2024 17:30:45',
    });
    expect(
      await validate(callback, { whitelist: true, forbidNonWhitelisted: true }),
    ).toEqual([]);
    http.get.mockReturnValue(of({ data: callback }));
    expect((await payments.handleFlexPayCallback(callback)).status).toBe(
      PaymentStatus.SUCCEEDED,
    );
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  it('does not trust a failed callback if the payout check is unavailable', async () => {
    const payment = await payments.initiatePayout(input);
    repository.findOne.mockResolvedValue(payment);
    http.get.mockReturnValue(throwError(() => new Error('Network error')));
    const result = await payments.handleFlexPayCallback({
      code: '1',
      reference: payment.reference,
      orderNumber: 'ORDER123',
    });
    expect(result.status).toBe(PaymentStatus.INITIATED);
  });

  it('rejects a callback attempting to replace an existing order number', async () => {
    const payment = await payments.initiatePayout(input);
    repository.findOne.mockResolvedValue(payment);
    await expect(
      payments.handleFlexPayCallback({
        code: '0',
        reference: payment.reference,
        orderNumber: 'OTHER_ORDER',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(payment.orderNumber).toBe('ORDER123');
    expect(http.get).not.toHaveBeenCalled();
  });

  it('recovers an uncertain send using a callback and an authenticated check', async () => {
    http.post
      .mockReturnValueOnce(of({ data: auth }))
      .mockReturnValueOnce(throwError(() => new Error('Timeout after send')));
    const payment = await payments.initiatePayout(input);
    expect(payment.status).toBe(PaymentStatus.PENDING);
    expect(payment.orderNumber).toBeNull();
    repository.findOne.mockResolvedValue(payment);
    http.get.mockReturnValue(
      of({
        data: {
          code: '0',
          status: '0',
          reference: payment.reference,
          orderNumber: 'ORDER123',
        },
      }),
    );
    const result = await payments.handleFlexPayCallback({
      code: '0',
      reference: payment.reference,
      orderNumber: 'ORDER123',
    });
    expect(result.status).toBe(PaymentStatus.SUCCEEDED);
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it('supports separate URLs for payout authentication and checks', async () => {
    config.FLEXPAY_PAYOUT_AUTH_URL =
      'https://auth.example.invalid/api/v1/auth/authenticate';
    config.FLEXPAY_PAYOUT_CHECK_TRANSACTION_URL =
      'https://check.example.invalid/api/rest/v1/check/{orderNumber}';
    http.get.mockReturnValue(of({ data: { code: '1', message: 'Not found' } }));
    await flexpay.checkPayoutTransaction('ORDER/123');
    expect(http.post.mock.calls[0][0]).toBe(config.FLEXPAY_PAYOUT_AUTH_URL);
    expect(http.get.mock.calls[0][0]).toBe(
      'https://check.example.invalid/api/rest/v1/check/ORDER%2F123',
    );
  });

  it.each([
    { code: '1', message: 'Transaction non trouvée' },
    {
      code: '0',
      status: '0',
      reference: 'UNRELATED_TRANSACTION',
      orderNumber: 'FORGED_ORDER',
    },
  ])(
    'does not bind an uncertain payout to an unverified callback order',
    async (data) => {
      http.post
        .mockReturnValueOnce(of({ data: auth }))
        .mockReturnValueOnce(throwError(() => new Error('Timeout')));
      const payment = await payments.initiatePayout(input);
      repository.findOne.mockResolvedValue(payment);
      http.get.mockReturnValue(of({ data }));
      const result = await payments.handleFlexPayCallback({
        code: '0',
        reference: payment.reference,
        orderNumber: 'FORGED_ORDER',
      });
      expect(result.status).toBe(PaymentStatus.PENDING);
      expect(result.orderNumber).toBeNull();
    },
  );

  it('keeps an HTTP 400 busy response uncertain instead of releasing the reservation', async () => {
    http.post.mockReturnValueOnce(of({ data: auth })).mockReturnValueOnce(
      throwError(() => ({
        isAxiosError: true,
        response: { status: 400, data: { code: '1', status: '0XX1' } },
      })),
    );
    expect((await payments.initiatePayout(input)).status).toBe(
      PaymentStatus.PENDING,
    );
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it('recognizes insufficient merchant funds by status in an HTTP rejection', async () => {
    http.post.mockReturnValueOnce(of({ data: auth })).mockReturnValueOnce(
      throwError(() => ({
        isAxiosError: true,
        response: {
          status: 400,
          data: { code: '1', status: '0XX2', message: 'Error' },
        },
      })),
    );
    await expect(payments.initiatePayout(input)).rejects.toThrow(
      PAYOUT_MESSAGES.funds,
    );
  });

  it('preserves USD cents and does not reuse the collection payload', async () => {
    await flexpay.initiatePayout({ ...input, amount: 10.25, currency: 'USD' });
    expect(http.post.mock.calls[1][1]).toEqual({
      merchant: 'PAYOUT_MERCHANT',
      type: '1',
      reference: input.reference,
      amount: '10.25',
      currency: 'USD',
      customer: '243891234567',
      description: input.description,
      callback_url: input.callbackUrl,
    });
  });

  it('reads the merchant balances through the authenticated payout API', async () => {
    http.get.mockReturnValue(
      of({
        data: {
          code: '0',
          balances: [
            { currency: 'USD', amount: '10' },
            { currency: 'CDF', amount: '5000' },
          ],
        },
      }),
    );
    expect(await flexpay.checkPayoutBalance()).toEqual({
      balances: [
        { currency: 'USD', amount: '10' },
        { currency: 'CDF', amount: '5000' },
      ],
    });
    expect(http.get.mock.calls[0][0]).toBe(
      'https://payout.example.invalid/api/rest/v1/balance/PAYOUT_MERCHANT',
    );
  });

  it('masks the new customer field in payment logs', () => {
    expect(
      formatPaymentLogPayload({ customer: '243891234567', token: 'secret' }),
    ).toBe('{"customer":"243***4567","token":"[redacted]"}');
  });
});
