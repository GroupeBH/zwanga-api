import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { PawaPayService } from './pawapay.service';
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
      service.initiatePayout({ ...input, phone: '+243811234567' }),
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
});
