import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { generateKeyPairSync } from 'node:crypto';
import { PawaPayService } from './pawapay.service';
import { signPawaPayRequest, verifyPawaPayCallback } from './pawapay-signature';
import {
  canFailoverPaymentProvider,
  isUncertainProviderDelivery,
} from './payment-provider.policy';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const input = {
  paymentId: id,
  phone: '+243891234567',
  amount: 1500.5,
  currency: 'CDF',
  description: 'Recharge test',
  clientReferenceId: 'TESTREF',
  operator: 'ORANGE_COD',
};

describe('PawaPay HTTP contract (no real transactions)', () => {
  const http = { post: jest.fn(), get: jest.fn() };
  const config = {
    get: jest.fn((key: string) =>
      key === 'PAWAPAY_API_TOKEN' ? 'test-only-token' : undefined,
    ),
  };
  const service = new PawaPayService(
    http as unknown as HttpService,
    config as unknown as ConfigService,
  );
  beforeEach(() => {
    http.post.mockReset();
    http.get.mockReset();
    jest.spyOn(service, 'getActiveConfiguration').mockResolvedValue({
      countries: [
        {
          country: 'COD',
          providers: [
            {
              provider: 'ORANGE_COD',
              currencies: [
                {
                  currency: 'CDF',
                  operationTypes: [
                    {
                      operationType: 'DEPOSIT',
                      status: 'OPERATIONAL',
                      decimalsInAmount: 'TWO',
                    },
                    {
                      operationType: 'PAYOUT',
                      status: 'OPERATIONAL',
                      decimalsInAmount: 'TWO',
                    },
                  ],
                },
              ],
            },
            {
              provider: 'VODACOM_MPESA_COD',
              currencies: [
                {
                  currency: 'CDF',
                  operationTypes: [
                    {
                      operationType: 'PAYOUT',
                      status: 'OPERATIONAL',
                      decimalsInAmount: 'NONE',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it.each(['ACCEPTED', 'DUPLICATE_IGNORED'])(
    'accepts %s without treating it as paid',
    async (status) => {
      http.post.mockReturnValue(of({ data: { depositId: id, status } }));
      const result = await service.initiateDeposit(input);
      expect(result.accepted).toBe(true);
      expect(service.isCompleted(result.status)).toBe(false);
      expect(http.post).toHaveBeenCalledWith(
        'https://api.sandbox.pawapay.io/v2/deposits',
        expect.objectContaining({
          amount: '1500.5',
          depositId: id,
          payer: {
            type: 'MMO',
            accountDetails: {
              phoneNumber: '243891234567',
              provider: 'ORANGE_COD',
            },
          },
        }),
        expect.objectContaining({ maxRedirects: 0, timeout: 30000 }),
      );
    },
  );

  it('uses the payout endpoint and recipient, without changing fractional CDF', async () => {
    http.post.mockReturnValue(
      of({ data: { payoutId: id, status: 'ACCEPTED' } }),
    );
    await service.initiatePayout(input);
    expect(http.post.mock.calls[0][0]).toContain('/v2/payouts');
    expect(http.post.mock.calls[0][1]).toMatchObject({
      payoutId: id,
      amount: '1500.5',
      recipient: { type: 'MMO' },
    });
    expect(http.post.mock.calls[0][1].payer).toBeUndefined();
  });

  it('rejects unsupported precision before any financial POST', async () => {
    await expect(
      service.initiatePayout({
        ...input,
        phone: '+243811234567',
        operator: 'VODACOM_MPESA_COD',
      }),
    ).rejects.toThrow('entier');
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { depositId: other, status: 'ACCEPTED' },
    { payoutId: id, status: 'ACCEPTED' },
    { depositId: id, status: 'UNKNOWN' },
  ])(
    'does not interpret a malformed initiation response as a safe failure: %j',
    async (data) => {
      http.post.mockReturnValue(of({ data }));
      const error = await service
        .initiateDeposit(input)
        .catch((e: unknown) => e);
      expect(isUncertainProviderDelivery(error)).toBe(true);
      expect(canFailoverPaymentProvider(error)).toBe(false);
    },
  );

  it.each([
    { code: 'ECONNRESET' },
    { code: 'ECONNABORTED' },
    { response: { status: 500 } },
    { response: { status: 502 } },
    { response: { status: 408 } },
    { response: { status: 429 } },
  ])('keeps ambiguous transport outcomes pending: %j', async (extra) => {
    http.post.mockReturnValue(
      throwError(() => ({
        isAxiosError: true,
        message: 'test error',
        ...extra,
      })),
    );
    const error = await service.initiatePayout(input).catch((e: unknown) => e);
    expect(isUncertainProviderDelivery(error)).toBe(true);
    expect(canFailoverPaymentProvider(error)).toBe(false);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('allows failover for an explicit pre-processing rejection', async () => {
    http.post.mockReturnValue(
      of({
        data: {
          depositId: id,
          status: 'REJECTED',
          failureReason: { failureCode: 'PROVIDER_TEMPORARILY_UNAVAILABLE' },
        },
      }),
    );
    const error = await service.initiateDeposit(input).catch((e: unknown) => e);
    expect(canFailoverPaymentProvider(error)).toBe(true);
    expect(isUncertainProviderDelivery(error)).toBe(false);
  });

  it('does not switch provider after an operator refusal', async () => {
    http.post.mockReturnValue(
      of({
        data: {
          depositId: id,
          status: 'REJECTED',
          failureReason: { failureCode: 'INVALID_AMOUNT' },
        },
      }),
    );
    expect((await service.initiateDeposit(input)).accepted).toBe(false);
  });

  it('unwraps a verified status response and handles NOT_FOUND separately', async () => {
    http.get
      .mockReturnValueOnce(
        of({
          data: {
            status: 'FOUND',
            data: {
              depositId: id,
              status: 'COMPLETED',
              amount: '1500.5',
              currency: 'CDF',
            },
          },
        }),
      )
      .mockReturnValueOnce(of({ data: { status: 'NOT_FOUND' } }));
    expect(await service.checkDeposit(id)).toMatchObject({
      paymentId: id,
      amount: '1500.5',
      status: 'COMPLETED',
    });
    expect(await service.checkDeposit(id)).toMatchObject({
      status: 'NOT_FOUND',
    });
  });

  it('rejects wrong operation ids in callbacks and invalid URL identifiers', async () => {
    expect(() =>
      service.normalizeCallback('deposits', {
        payoutId: id,
        status: 'COMPLETED',
      }),
    ).toThrow();
    await expect(service.checkDeposit('../payouts')).rejects.toThrow();
    expect(http.get).not.toHaveBeenCalled();
  });

  it('uses the documented predict-provider contract', async () => {
    http.post.mockReturnValue(
      of({
        data: {
          country: 'COD',
          provider: 'ORANGE_COD',
          phoneNumber: '243891234567',
        },
      }),
    );
    await expect(service.predictProvider(input.phone)).resolves.toMatchObject({
      provider: 'ORANGE_COD',
    });
    expect(http.post).toHaveBeenCalledWith(
      'https://api.sandbox.pawapay.io/v2/predict-provider',
      { phoneNumber: '243891234567' },
      expect.objectContaining({ timeout: 30000 }),
    );
  });

  it('initiates an idempotent refund with deposit id, amount and currency', async () => {
    http.post.mockReturnValue(
      of({ data: { refundId: other, status: 'ACCEPTED' } }),
    );
    const result = await service.initiateRefund({
      refundId: other,
      depositId: id,
      amount: 0.29,
      currency: 'CDF',
      clientReferenceId: 'TESTREF',
    });
    expect(result.accepted).toBe(true);
    expect(http.post).toHaveBeenCalledWith(
      'https://api.sandbox.pawapay.io/v2/refunds',
      {
        refundId: other,
        depositId: id,
        amount: '0.29',
        currency: 'CDF',
        clientReferenceId: 'TESTREF',
      },
      expect.any(Object),
    );
  });

  it('signs the exact outbound body when a key is configured', async () => {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privatePem = keys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const publicPem = keys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const signedService = new PawaPayService(
      http as unknown as HttpService,
      {
        get: (key: string) =>
          ({
            PAWAPAY_API_TOKEN: 'test-only-token',
            PAWAPAY_SIGNING_PRIVATE_KEY_BASE64:
              Buffer.from(privatePem).toString('base64'),
            PAWAPAY_SIGNING_KEY_ID: 'ZWANGA_TEST_KEY',
          })[key],
      } as ConfigService,
    );
    jest
      .spyOn(signedService, 'getActiveConfiguration')
      .mockResolvedValue(await service.getActiveConfiguration());
    http.post.mockReturnValue(
      of({ data: { depositId: id, status: 'ACCEPTED' } }),
    );
    await signedService.initiateDeposit(input);
    const [url, body, options] = http.post.mock.calls[0];
    expect(typeof body).toBe('string');
    const headers = Object.fromEntries(
      Object.entries(options.headers).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    expect(
      verifyPawaPayCallback({
        method: 'POST',
        url,
        body: Buffer.from(body),
        headers,
        publicKeyPem: publicPem,
      }),
    ).toBe('ZWANGA_TEST_KEY');
  });

  it('verifies a signed callback against the public-key endpoint', async () => {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privatePem = keys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const publicPem = keys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const verifyService = new PawaPayService(
      http as unknown as HttpService,
      {
        get: (key: string) =>
          ({
            PAWAPAY_API_TOKEN: 'test-only-token',
            PAWAPAY_REQUIRE_SIGNED_CALLBACKS: 'true',
          })[key],
      } as ConfigService,
    );
    const rawBody = Buffer.from(
      JSON.stringify({ depositId: id, status: 'COMPLETED' }),
    );
    const callbackPath = '/api/v1/payments/pawapay/deposits/callback';
    const headers = signPawaPayRequest(
      `https://api.zwanga.test${callbackPath}`,
      rawBody.toString(),
      privatePem,
      'PP_TEST',
    );
    http.get.mockReturnValue(of({ data: [{ id: 'PP_TEST', key: publicPem }] }));
    const request = {
      method: 'POST',
      originalUrl: callbackPath,
      rawBody,
      headers: {
        host: 'api.zwanga.test',
        ...Object.fromEntries(
          Object.entries(headers).map(([name, value]) => [
            name.toLowerCase(),
            value,
          ]),
        ),
      },
    };
    await expect(
      verifyService.verifyCallbackRequest(request as any),
    ).resolves.toBeUndefined();
    expect(http.get).toHaveBeenCalledWith(
      'https://api.sandbox.pawapay.io/v2/public-key/http',
      expect.any(Object),
    );
    await expect(
      verifyService.verifyCallbackRequest({
        ...request,
        rawBody: Buffer.from('{}'),
      } as any),
    ).rejects.toThrow();
  });
});
