import { DataSource } from 'typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { TransactionalNotificationsSubscriber } from './transactional-notifications.subscriber';
import {
  WalletLedgerEntry,
  WalletLedgerEntryType,
} from '../wallet/entities/wallet-ledger-entry.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import { DriverPayout } from '../driver-settlements/entities/driver-payout.entity';
import { PaymentTransaction } from '../payments/entities/payment-transaction.entity';
import { PawaPayRefund } from '../payments/entities/pawapay-refund.entity';
import {
  ProServiceCase,
  ProServiceLedger,
} from '../pro-services/pro-service.entities';

const fixture = () => {
  const dataSource = { subscribers: [] } as unknown as DataSource;
  const subscriber = new TransactionalNotificationsSubscriber(dataSource);
  const builder = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    onConflict: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
  };
  const manager = {
    createQueryBuilder: jest.fn(() => builder),
    findOneBy: jest.fn(),
  };
  const event = (target: unknown, entity: object, databaseEntity?: object) =>
    ({
      metadata: { target, tableName: 'fixture' },
      manager,
      entity,
      databaseEntity,
    }) as any;
  return { dataSource, subscriber, builder, manager, event };
};

describe('transactional notification subscriber', () => {
  it('persists new pending booking invitations with a stable key in the business transaction', async () => {
    const f = fixture();
    f.manager.findOneBy.mockResolvedValue({ id: 'trip', driverId: 'driver', tripRequestId: null });
    await f.subscriber.afterInsert(f.event(Booking, { id: 'booking', tripId: 'trip', status: 'pending' }));
    expect(f.builder.values).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: 'booking:booking:new', userId: 'driver', fcmToken: '', status: 'pending',
      data: expect.objectContaining({ type: 'new_booking', bookingId: 'booking', driverId: 'driver' }),
    }));
    expect(f.builder.onConflict).toHaveBeenCalledWith('("eventKey") DO NOTHING');
    expect(() => f.subscriber.beforeInsert({ ...f.event(Booking, {}), queryRunner: { isTransactionActive: false } })).toThrow('require a transaction');
  });

  it('does not turn an assigned request or already accepted booking into another invitation', async () => {
    const f = fixture();
    f.manager.findOneBy.mockResolvedValue({ id: 'trip', driverId: 'driver', tripRequestId: 'request' });
    await f.subscriber.afterInsert(f.event(Booking, { id: 'booking', tripId: 'trip', status: 'pending' }));
    await f.subscriber.afterInsert(f.event(Booking, { id: 'accepted', tripId: 'trip', status: 'accepted' }));
    expect(f.builder.execute).not.toHaveBeenCalled();
  });
  it('registers with Nest data source and unregisters on shutdown', () => {
    const f = fixture();
    expect(f.dataSource.subscribers).toContain(f.subscriber);
    f.subscriber.onModuleDestroy();
    expect(f.dataSource.subscribers).toHaveLength(0);
  });

  it('rejects non-transactional financial inserts before any SQL write', () => {
    const f = fixture();
    expect(() =>
      f.subscriber.beforeInsert({
        ...f.event(WalletLedgerEntry, { id: 'entry' }),
        queryRunner: { isTransactionActive: false },
      }),
    ).toThrow('require a transaction');
  });

  it('rejects partial state updates without a previous row, but permits technical updates', () => {
    const f = fixture();
    expect(() =>
      f.subscriber.beforeUpdate({
        ...f.event(DriverPayout, { status: 'succeeded' }),
        queryRunner: { isTransactionActive: true },
      }),
    ).toThrow('transactional save()');
    expect(() =>
      f.subscriber.beforeUpdate(
        f.event(DriverPayout, { lastReconciledAt: new Date() }),
      ),
    ).not.toThrow();
  });

  it('enqueues admin wallet adjustments using the business event manager and a conflict-safe key', async () => {
    const f = fixture();
    await f.subscriber.afterInsert(
      f.event(WalletLedgerEntry, {
        id: 'entry',
        userId: 'user',
        type: WalletLedgerEntryType.ADMIN_ADJUSTMENT,
        amount: 25,
        balanceAfter: 125,
        currency: 'PTS',
      }),
    );
    expect(f.builder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: 'wallet:entry',
        userId: 'user',
        status: 'pending',
        fcmToken: '',
        isAutomatic: false,
      }),
    );
    expect(f.builder.onConflict).toHaveBeenCalledWith(
      '("eventKey") DO NOTHING',
    );
  });

  it.each([KycStatus.APPROVED, KycStatus.REJECTED])(
    'enqueues manual KYC %s without exposing rejection notes or documents',
    async (status) => {
      const f = fixture();
      await f.subscriber.afterUpdate(
        f.event(
          KycDocument,
          {
            id: 'kyc',
            userId: 'user',
            status,
            reviewedBy: 'admin',
            reviewedAt: new Date('2026-10-04T10:00:00Z'),
            rejectionReason: 'sensitive',
            cniFrontUrl: 'secret-url',
          },
          { status: KycStatus.PENDING },
        ),
      );
      const row = f.builder.values.mock.calls[0][0];
      expect(row).toMatchObject({
        userId: 'user',
        data: { type: `kyc_${status}`, kycId: 'kyc' },
      });
      expect(JSON.stringify(row)).not.toMatch(/sensitive|secret-url/);
    },
  );

  it('does not re-notify unchanged KYC decisions, technical payout updates or immutable ledger updates', async () => {
    const f = fixture();
    await f.subscriber.afterUpdate(
      f.event(
        KycDocument,
        { id: 'kyc', status: 'approved', reviewedBy: 'admin' },
        { status: 'approved', reviewedBy: 'admin' },
      ),
    );
    await f.subscriber.afterUpdate(
      f.event(DriverPayout, { lastReconciledAt: new Date() }),
    );
    await f.subscriber.afterUpdate(
      f.event(WalletLedgerEntry, { id: 'entry', description: 'corrected' }),
    );
    expect(f.builder.execute).not.toHaveBeenCalled();
  });

  it('queues a provider approval without requiring an admin reviewer', async () => {
    const f = fixture();
    await f.subscriber.afterUpdate(
      f.event(
        KycDocument,
        { id: 'kyc', userId: 'user', status: 'approved', reviewedBy: null },
        { status: 'pending' },
      ),
    );
    expect(f.builder.values).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user',
      title: 'Identité vérifiée',
      data: expect.objectContaining({ type: 'kyc_approved', kycId: 'kyc' }),
    }));
  });

  it('does not attribute a later Didit status update to an older admin decision', async () => {
    const f = fixture();
    const reviewedAt = new Date('2026-10-04T10:00:00Z');
    await f.subscriber.afterUpdate(
      f.event(
        KycDocument,
        {
          id: 'kyc',
          userId: 'user',
          status: 'approved',
          reviewedBy: 'admin',
          reviewedAt,
        },
        { status: 'rejected', reviewedBy: 'admin', reviewedAt },
      ),
    );
    const row = f.builder.values.mock.calls[0][0];
    expect(row.data.type).toBe('kyc_approved');
    expect(row.body).not.toContain('notre équipe');
  });

  it('notifies an approval inserted directly, but not pending or automatic rejections', async () => {
    const f = fixture();
    for (const status of [KycStatus.PENDING, KycStatus.REJECTED, KycStatus.APPROVED]) {
      await f.subscriber.afterInsert(f.event(KycDocument, {
        id: 'kyc', userId: 'user', status, reviewedBy: null,
      }));
    }
    expect(f.builder.execute).toHaveBeenCalledTimes(1);
    expect(f.builder.values.mock.calls[0][0].data.type).toBe('kyc_approved');
  });

  it('does not notify again when polling or an admin confirms an existing approval', async () => {
    const f = fixture();
    const decision = {
      id: 'kyc', userId: 'user', status: 'approved', reviewedBy: null,
      reviewedAt: new Date('2026-10-07T10:00:00Z'),
    };
    await f.subscriber.afterUpdate(f.event(KycDocument,
      { ...decision, diditLastSyncedAt: new Date() }, decision));
    await f.subscriber.afterUpdate(f.event(KycDocument,
      { ...decision, reviewedBy: 'admin' }, decision));
    expect(f.builder.execute).not.toHaveBeenCalled();
  });

  it('notifies a refund to the payer, never to the admin requesting it', async () => {
    const f = fixture();
    f.manager.findOneBy.mockResolvedValue({ id: 'payment', userId: 'payer' });
    await f.subscriber.afterUpdate(
      f.event(
        PawaPayRefund,
        {
          id: 'refund',
          paymentTransactionId: 'payment',
          createdByUserId: 'admin',
          status: 'completed',
          amount: 500,
          currency: 'CDF',
        },
        { status: 'initiated' },
      ),
    );
    expect(f.manager.findOneBy).toHaveBeenCalledWith(PaymentTransaction, {
      id: 'payment',
    });
    expect(f.builder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: 'refund:refund:completed',
        userId: 'payer',
      }),
    );
  });

  it('notifies only the financing dossier owner using the correct minor-unit amount', async () => {
    const f = fixture();
    f.manager.findOneBy.mockResolvedValue({ ownerId: 'owner' });
    await f.subscriber.afterInsert(
      f.event(ProServiceLedger, {
        id: 'entry',
        caseId: 'case',
        amountMinor: 1050,
        currency: 'USD',
        kind: 'deposit',
        evidence: 'sensitive',
      }),
    );
    expect(f.manager.findOneBy).toHaveBeenCalledWith(ProServiceCase, {
      id: 'case',
    });
    expect(f.builder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner',
        body: expect.stringContaining('10,5 USD'),
      }),
    );
  });

  it('propagates an outbox persistence failure to roll back the business transaction', async () => {
    const f = fixture();
    f.builder.execute.mockRejectedValue(new Error('database unavailable'));
    await expect(
      f.subscriber.afterInsert(
        f.event(WalletLedgerEntry, {
          id: 'entry',
          userId: 'user',
          amount: 1,
          balanceAfter: 10,
          currency: 'PTS',
          type: 'admin_adjustment',
        }),
      ),
    ).rejects.toThrow('database unavailable');
  });
});
