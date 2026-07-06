import { of } from 'rxjs';
import { PaymentMethod } from './entities/payment-transaction.entity';
import { FlexPayService } from './flexpay.service';

describe('FlexPayService', () => {
  let httpService: { post: jest.Mock; get: jest.Mock };
  let config: Record<string, string>;
  let service: FlexPayService;

  const baseInput = {
    reference: 'TEST0014521',
    amount: 100,
    currency: 'CDF',
    description: 'Tests de paiement',
    callbackUrl: 'https://api.zwanga.cd/api/v1/subscriptions/flexpay/callback',
  };

  beforeEach(() => {
    httpService = {
      post: jest.fn(),
      get: jest.fn(),
    };
    config = {
      FLEXPAY_MERCHANT_CODE: 'ZANDO',
      FLEX_PAIE_TOKEN: 'test-token',
    };

    service = new FlexPayService(httpService as any, {
      get: jest.fn((key: string) => config[key]),
    } as any);
  });

  it('sends Mobile Money payments to the FlexPay paymentService endpoint', async () => {
    httpService.post.mockReturnValue(
      of({
        data: {
          code: '0',
          message: 'Transaction envoyee avec succes',
          orderNumber: '9bsTX7qXdpQe243891234567',
        },
      }),
    );

    const result = await service.initiatePayment({
      ...baseInput,
      method: PaymentMethod.MOBILE_MONEY,
      phone: '+243 891 234 567',
    });

    expect(httpService.post).toHaveBeenCalledWith(
      'https://beta-backend.flexpay.cd/api/rest/v1/paymentService',
      {
        merchant: 'ZANDO',
        type: '1',
        phone: '243891234567',
        reference: 'TEST0014521',
        amount: '100',
        currency: 'CDF',
        callbackUrl:
          'https://api.zwanga.cd/api/v1/subscriptions/flexpay/callback',
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
        timeout: 30000,
      }),
    );
    expect(result.orderNumber).toBe('9bsTX7qXdpQe243891234567');
  });

  it('sends card payments to the FlexPay card endpoint and returns the redirect url', async () => {
    httpService.post.mockReturnValue(
      of({
        data: {
          code: '0',
          message: 'Redirection en cours',
          orderNumber: 'LeR4frf04509172137498452',
          url: 'https://beta-cardpayment.flexpay.cd/redirect/LeR4',
        },
      }),
    );

    const result = await service.initiatePayment({
      ...baseInput,
      method: PaymentMethod.CARD,
      currency: 'USD',
      approveUrl: 'zwanga://subscriptions/payment?status=success',
      cancelUrl: 'zwanga://subscriptions/payment?status=cancel',
      declineUrl: 'zwanga://subscriptions/payment?status=decline',
    });

    expect(httpService.post).toHaveBeenCalledWith(
      'https://beta-cardpayment.flexpay.cd/v1.1/pay',
      {
        authorization: 'Bearer test-token',
        merchant: 'ZANDO',
        reference: 'TEST0014521',
        amount: '100',
        currency: 'USD',
        description: 'Tests de paiement',
        callback_url:
          'https://api.zwanga.cd/api/v1/subscriptions/flexpay/callback',
        approve_url: 'zwanga://subscriptions/payment?status=success',
        cancel_url: 'zwanga://subscriptions/payment?status=cancel',
        decline_url: 'zwanga://subscriptions/payment?status=decline',
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
        timeout: 30000,
      }),
    );
    expect(result.paymentUrl).toBe(
      'https://beta-cardpayment.flexpay.cd/redirect/LeR4',
    );
  });

  it('checks a transaction by orderNumber with the FlexPay check endpoint', async () => {
    httpService.get.mockReturnValue(
      of({
        data: {
          Code: '0',
          Message: 'Une transaction trouvee',
          Transaction: {
            orderNumber: '9bsTX7qXdpQe243891234567',
            reference: 'TEST0014521',
            amount: '100.0',
            amountCustomer: '101.0',
            currency: 'CDF',
            createdAt: '06-02-2021 17:32:46',
            status: '0',
          },
        },
      }),
    );

    const result = await service.checkTransaction(
      '9bsTX7qXdpQe243891234567',
    );

    expect(httpService.get).toHaveBeenCalledWith(
      'https://beta-backend.flexpay.cd/api/rest/v1/check/9bsTX7qXdpQe243891234567',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
        timeout: 30000,
      }),
    );
    expect(result.transaction?.status).toBe('0');
  });
});
