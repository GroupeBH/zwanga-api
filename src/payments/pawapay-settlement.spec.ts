import { BadGatewayException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PawaPayService } from './pawapay.service';
import { PaymentSettlementRegistry } from './payment-settlement.registry';
import { PaymentGatewayUnavailableError } from './payment-provider.policy';
import { hasVerifiedWalletTopUpProof } from './wallet-topup-proof';
import { commitPawaPayState } from './pawapay-payment-state';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

describe('PawaPay settlement guards', () => {
  let row: PaymentTransaction;
  let repo: any;
  let service: PaymentsService;
  let pawa: any;
  let flex: any;
  let settle: jest.Mock;
  const config: any = {
    get: (key: string) =>
      key === 'PAWAPAY_VERIFY_CALLBACKS' ? 'false' : undefined,
  };
  const parser = new PawaPayService({} as any, config);
  const callback = (patch = {}) => ({
    depositId: id,
    status: 'COMPLETED',
    ...patch,
  });
  const proof = (patch = {}, kind: 'deposits' | 'payouts' = 'deposits') =>
    parser.normalizeCallback(kind, {
      [kind === 'deposits' ? 'depositId' : 'payoutId']: row.orderNumber,
      status: 'COMPLETED',
      amount: '1500',
      currency: 'CDF',
      clientReferenceId: row.reference,
      ...patch,
    });

  beforeEach(() => {
    row = {
      id: 'payment',
      provider: PaymentProvider.PAWAPAY,
      orderNumber: id,
      reference: 'TESTREF',
      status: PaymentStatus.INITIATED,
      amount: 1500,
      currency: 'CDF',
      purpose: PaymentPurpose.WALLET_TOP_UP,
      relatedEntityType: 'wallet_top_up',
      relatedEntityId: 'user-test',
      userId: 'user-test',
      rawCheckResponse: null,
    } as PaymentTransaction;
    const manager = {
      findOne: jest.fn(async () => ({ ...row })),
      save: jest.fn(async (_entity, value) => {
        row = { ...value };
        return { ...row };
      }),
    };
    repo = {
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => {
        row = { id: 'payment', ...value };
        return { ...row };
      }),
      findOne: jest.fn(async () => ({ ...row })),
      manager: { transaction: jest.fn((run) => run(manager)) },
    };
    pawa = {
      isConfigured: () => true,
      normalizeCallback: parser.normalizeCallback.bind(parser),
      isCompleted: parser.isCompleted.bind(parser),
      isFailed: parser.isFailed.bind(parser),
      checkDeposit: jest.fn(async () => proof()),
      checkPayout: jest.fn(async () => proof({}, 'payouts')),
      initiateDeposit: jest.fn(async () => ({
        accepted: true,
        status: 'ACCEPTED',
        raw: {},
      })),
      initiatePayout: jest.fn(async () => ({
        accepted: true,
        status: 'ACCEPTED',
        raw: {},
      })),
    };
    flex = {
      initiatePayment: jest.fn(),
      initiatePayout: jest.fn(),
      isSuccessfulCode: (code) => code === '0',
    };
    const registry = new PaymentSettlementRegistry();
    settle = jest.fn(async () => undefined);
    Object.values(PaymentPurpose).forEach((purpose) =>
      registry.register(purpose, settle),
    );
    service = new PaymentsService(repo, config, flex, pawa, registry);
  });

  it('always verifies callbacks even when the old environment switch is false', async () => {
    await service.handlePawaPayCallback(
      'deposits',
      callback({ amount: '99999', currency: 'USD' }),
    );
    expect(pawa.checkDeposit).toHaveBeenCalledWith(id);
    expect(row.amount).toBe(1500);
    expect(row.status).toBe(PaymentStatus.SUCCEEDED);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it.each([
    PaymentPurpose.TRIP_BOOKING,
    PaymentPurpose.SUBSCRIPTION_PRO,
    PaymentPurpose.WALLET_TOP_UP,
    PaymentPurpose.DRIVER_PAYOUT,
    PaymentPurpose.REFERRAL_PAYOUT,
    PaymentPurpose.WALLET_PAYOUT,
  ])(
    'validates amount and currency for %s, not just topups',
    async (purpose) => {
      row.purpose = purpose;
      const payout = purpose.endsWith('payout');
      const kind = payout ? 'payouts' : 'deposits';
      (payout ? pawa.checkPayout : pawa.checkDeposit).mockImplementation(
        async () => proof({ amount: '1' }, kind),
      );
      await expect(
        service.handlePawaPayCallback(kind, {
          [payout ? 'payoutId' : 'depositId']: id,
          status: 'COMPLETED',
        }),
      ).rejects.toThrow('montant');
      expect(row.status).toBe(PaymentStatus.INITIATED);
      expect(settle).not.toHaveBeenCalled();
    },
  );

  it.each([
    { currency: null },
    { currency: 'USD' },
    { amount: null },
    { depositId: other },
    { clientReferenceId: 'WRONG' },
  ])('rejects mismatched provider evidence: %j', async (patch) => {
    pawa.checkDeposit.mockImplementation(async () => proof(patch));
    await expect(
      service.handlePawaPayCallback('deposits', callback()),
    ).rejects.toThrow();
    expect(settle).not.toHaveBeenCalled();
  });

  it('rejects wrong callback kind, provider, identifier and reference before HTTP', async () => {
    await expect(
      service.handlePawaPayCallback('payouts', {
        payoutId: id,
        status: 'COMPLETED',
      }),
    ).rejects.toThrow();
    await expect(
      service.handlePawaPayCallback('refunds', {
        refundId: id,
        status: 'COMPLETED',
      }),
    ).rejects.toThrow();
    await expect(
      service.handlePawaPayCallback('deposits', callback({ depositId: other })),
    ).rejects.toThrow();
    await expect(
      service.handlePawaPayCallback(
        'deposits',
        callback({ clientReferenceId: 'OTHER' }),
      ),
    ).rejects.toThrow();
    row.provider = PaymentProvider.FLEXPAY;
    await expect(
      service.handlePawaPayCallback('deposits', callback()),
    ).rejects.toThrow();
    expect(pawa.checkDeposit).not.toHaveBeenCalled();
    expect(pawa.checkPayout).not.toHaveBeenCalled();
  });

  it('rejects FlexPay callbacks targeting a PawaPay transaction', async () => {
    await expect(
      service.handleFlexPayCallback({
        reference: row.reference,
        code: '0',
        orderNumber: id,
      }),
    ).rejects.toThrow('FlexPay');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('lets the provider retry if verification or business settlement failed', async () => {
    pawa.checkDeposit.mockRejectedValueOnce(new BadGatewayException());
    await expect(
      service.handlePawaPayCallback('deposits', callback()),
    ).rejects.toThrow();
    expect(row.status).toBe(PaymentStatus.INITIATED);
    settle.mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(
      service.handlePawaPayCallback('deposits', callback()),
    ).rejects.toThrow('ledger');
    expect(row.status).toBe(PaymentStatus.SUCCEEDED);
    // Use real v2 proof to exercise the local terminal-status recovery path.
    row.rawCheckResponse = { status: 'FOUND', data: proof().raw };
    await service.checkPaymentStatus(id, row.userId!);
    expect(settle).toHaveBeenCalledTimes(2);
    expect(pawa.checkDeposit).toHaveBeenCalledTimes(2);
  });

  it('never credits based on callback payload alone', () => {
    row.status = PaymentStatus.SUCCEEDED;
    row.rawCallbackPayload = proof().raw;
    expect(hasVerifiedWalletTopUpProof(row)).toBe(false);
    row.rawCheckResponse = { status: 'FOUND', data: proof().raw };
    expect(hasVerifiedWalletTopUpProof(row)).toBe(true);
  });

  it('does not acknowledge a final callback while the provider still returns NOT_FOUND', async () => {
    pawa.checkDeposit.mockResolvedValue({ status: 'NOT_FOUND' });
    await expect(
      service.handlePawaPayCallback('deposits', callback()),
    ).rejects.toThrow('vérifiée');
    expect(row.status).toBe(PaymentStatus.INITIATED);
    expect(settle).not.toHaveBeenCalled();
  });

  it('keeps the original successful proof when a later response fails', async () => {
    await service.handlePawaPayCallback('deposits', callback());
    const originalProof = row.rawCheckResponse;
    pawa.checkDeposit.mockImplementation(async () =>
      proof({ status: 'FAILED' }),
    );
    await service.handlePawaPayCallback(
      'deposits',
      callback({ status: 'FAILED' }),
    );
    expect(row.status).toBe(PaymentStatus.SUCCEEDED);
    expect(row.rawCheckResponse).toEqual(originalProof);
  });

  it.each([
    PaymentStatus.PENDING,
    PaymentStatus.INITIATED,
    PaymentStatus.FAILED,
  ])(
    'keeps a concurrent success when a stale response proposes %s',
    async (status) => {
      const stale = { ...row };
      row.status = PaymentStatus.SUCCEEDED;
      await commitPawaPayState(repo, stale, { status });
      expect(row.status).toBe(PaymentStatus.SUCCEEDED);
    },
  );

  it('requires reconciliation instead of silently acknowledging a success after final failure', async () => {
    row.status = PaymentStatus.FAILED;
    await expect(service.handlePawaPayCallback('deposits', callback())).rejects.toThrow('rapprochement');
    expect(row.status).toBe(PaymentStatus.FAILED);
    expect(settle).not.toHaveBeenCalled();
  });

  const input = {
    userId: 'user-test',
    phone: '+243891234567',
    amount: 1500,
    currency: 'CDF',
    description: 'Test payment',
    method: PaymentMethod.MOBILE_MONEY,
  };

  it.each(['deposit', 'payout'])(
    'keeps ambiguous %s pending with its UUID and no fallback',
    async (kind) => {
      const error = new PaymentGatewayUnavailableError(
        PaymentProvider.PAWAPAY,
        'reset',
        { uncertainDelivery: true },
      );
      pawa.initiateDeposit.mockRejectedValue(error);
      pawa.initiatePayout.mockRejectedValue(error);
      const result =
        kind === 'deposit'
          ? await service.initiatePayment({
              ...input,
              preferredProvider: PaymentProvider.PAWAPAY,
            })
          : await service.initiatePayout({
              ...input,
              preferredProvider: PaymentProvider.PAWAPAY,
            });
      expect(result.status).toBe(PaymentStatus.PENDING);
      expect(result.orderNumber).toMatch(/^[0-9a-f-]{36}$/);
      expect(flex.initiatePayment).not.toHaveBeenCalled();
      expect(flex.initiatePayout).not.toHaveBeenCalled();
    },
  );

  it('allows FlexPay to PawaPay fallback only after a proven pre-processing rejection', async () => {
    flex.initiatePayment.mockRejectedValue(
      new PaymentGatewayUnavailableError(
        PaymentProvider.FLEXPAY,
        'not configured',
        { retryable: true },
      ),
    );
    const result = await service.initiatePayment(input);
    expect(result.provider).toBe(PaymentProvider.PAWAPAY);
    expect(result.status).toBe(PaymentStatus.INITIATED);
    expect(pawa.initiateDeposit).toHaveBeenCalledTimes(1);
  });
});
