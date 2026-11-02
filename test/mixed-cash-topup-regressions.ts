import { randomUUID } from 'crypto';
import type { DataSource } from 'typeorm';
import { Booking } from '../src/bookings/entities/booking.entity';
import type { MixedCashPaymentService } from '../src/bookings/mixed-cash-payment.service';
import type { MixedCashPaymentDto } from '../src/bookings/dto/mixed-cash-payment.dto';
import { PaymentTransaction, PaymentPurpose, PaymentMethod, PaymentStatus } from '../src/payments/entities/payment-transaction.entity';
import { WalletAccount } from '../src/wallet/entities/wallet-account.entity';
import { WalletLedgerEntry, WalletLedgerEntryType } from '../src/wallet/entities/wallet-ledger-entry.entity';
import type { WalletService } from '../src/wallet/wallet.service';

type Fixture = {
  service: MixedCashPaymentService; booking: Booking; passenger: { id: string };
  wallet: WalletService; input: MixedCashPaymentDto;
};

/** Real service + PostgreSQL + wallet ledger. No provider calls or real users. */
export function mixedCashTopUpRegressions(createFixture: (balance?: number) => Promise<Fixture>, source: () => DataSource) {
  const topUp = (f: Fixture, status: PaymentStatus) => source().getRepository(PaymentTransaction).save({
    userId: f.passenger.id, purpose: PaymentPurpose.WALLET_TOP_UP, relatedEntityType: 'wallet_top_up',
    relatedEntityId: f.passenger.id, method: PaymentMethod.MOBILE_MONEY, status,
    reference: randomUUID(), orderNumber: randomUUID(), amount: 3920, tokenQuantity: 392, currency: 'CDF',
  });
  const verifyAndCredit = async (f: Fixture, payment: PaymentTransaction) => {
    payment.status = PaymentStatus.SUCCEEDED;
    payment.rawCheckResponse = { code: '0', transaction: { status: '0', amount: '3920', currency: 'CDF',
      reference: payment.reference, orderNumber: payment.orderNumber } };
    await source().getRepository(PaymentTransaction).save(payment);
    return (f.wallet as unknown as { applyTopUpPayment: (p: PaymentTransaction) => Promise<WalletAccount> }).applyTopUpPayment(payment);
  };
  const balance = async (f: Fixture) => Number((await source().getRepository(WalletAccount)
    .findOneByOrFail({ userId: f.passenger.id })).balance);
  const pay = (f: Fixture) => f.service.pay(f.booking.id, f.passenger.id, f.input);

  it.each([PaymentStatus.PENDING, PaymentStatus.INITIATED])(
    '3500 CDF: 65 tokens plus 2850 cash is not blocked by a wallet top-up %s', async status => {
      const f = await createFixture(65);
      await source().getRepository(Booking).update(f.booking.id, { paymentAmount: 3500, grossPaymentAmount: 3500 });
      f.input = { expectedAmount: 3500, expectedTokenAmount: 650, tokenQuantity: 65, currency: 'CDF' };
      const pending = await topUp(f, status);
      const results = await Promise.all([pay(f), pay(f)]);
      for (const result of results) {
        expect(Number(result.paymentAmount)).toBe(2850);
        expect(Number(result.mixedTokenAmount)).toBe(650);
        expect(result.cashReceivedAt).toBeNull();
      }
      expect(await balance(f)).toBe(0);
      expect(await source().getRepository(WalletLedgerEntry).countBy({ type: WalletLedgerEntryType.BOOKING_PAYMENT })).toBe(1);
      expect(await source().getRepository(PaymentTransaction).findOneByOrFail({ id: pending.id }))
        .toMatchObject({ status, reference: pending.reference, orderNumber: pending.orderNumber });
    });

  it.each(['before', 'during', 'after'] as const)(
    'a verified wallet top-up %s the cash split credits once without spending the extra tokens', async timing => {
      const f = await createFixture(), pending = await topUp(f, PaymentStatus.PENDING);
      if (timing === 'before') await verifyAndCredit(f, pending);
      if (timing === 'during') await Promise.all([pay(f), verifyAndCredit(f, pending)]);
      else await pay(f);
      if (timing === 'after') await verifyAndCredit(f, pending);
      await verifyAndCredit(f, pending); // Duplicate verified callback.
      const retried = await pay(f);
      expect(Number(retried.paymentAmount)).toBe(3920);
      expect(Number(retried.mixedTokenQuantity)).toBe(58);
      expect(retried.cashReceivedAt).toBeNull();
      expect(await balance(f)).toBe(392);
      expect(await source().getRepository(WalletLedgerEntry).countBy({ type: WalletLedgerEntryType.TOP_UP })).toBe(1);
      expect(await source().getRepository(WalletLedgerEntry).countBy({ type: WalletLedgerEntryType.BOOKING_PAYMENT })).toBe(1);
      await expect(f.wallet.payForBooking(f.booking, 4500)).rejects.toThrow('déjà débité');
      expect(await balance(f)).toBe(392);
    });

  it.each([PaymentStatus.PENDING, PaymentStatus.INITIATED, PaymentStatus.SUCCEEDED])(
    'still blocks a direct booking collection %s without debiting tokens', async status => {
      const f = await createFixture();
      await topUp(f, PaymentStatus.PENDING);
      await source().getRepository(PaymentTransaction).save({ userId: f.passenger.id,
        purpose: PaymentPurpose.TRIP_BOOKING, relatedEntityType: 'booking', relatedEntityId: f.booking.id,
        method: PaymentMethod.MOBILE_MONEY, status, reference: randomUUID(), amount: 4500, currency: 'CDF' });
      await expect(pay(f)).rejects.toMatchObject({ status: 409 });
      expect(await balance(f)).toBe(58);
      expect(await source().getRepository(WalletLedgerEntry).count()).toBe(0);
      expect((await source().getRepository(Booking).findOneByOrFail({ id: f.booking.id })).mixedPaymentAt).toBeNull();
    });
}
