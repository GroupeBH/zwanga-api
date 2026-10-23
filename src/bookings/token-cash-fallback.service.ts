import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Booking, BookingPaymentStatus, BookingStatus } from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { PaymentPurpose, PaymentTransaction } from '../payments/entities/payment-transaction.entity';
import { WalletLedgerEntry, WalletLedgerEntryType } from '../wallet/entities/wallet-ledger-entry.entity';
import { BookingsService } from './bookings.service';

/** A wallet purchase stays reconcilable. This command changes ONLY the ride,
 * under the same lock as token settlement. It never cancels a provider charge,
 * deletes a payment transaction, debits tokens, or confirms receipt of cash. */
@Injectable()
export class TokenCashFallbackService {
  constructor(private readonly db: DataSource, private readonly bookings: BookingsService) {}

  async switchToCash(id: string, passengerId: string): Promise<Booking> {
    const result = await this.db.transaction(async manager => {
      const booking = await manager.findOne(Booking, {
        where: { id, passengerId }, lock: { mode: 'pessimistic_write' },
      });
      if (!booking) throw new NotFoundException('Réservation introuvable.');
      if (booking.tokenCashFallbackAt) return booking;
      if (booking.status !== BookingStatus.COMPLETED || !booking.droppedOff ||
          booking.mixedPaymentAt || booking.cashReceivedAt ||
          booking.paymentStatus === BookingPaymentStatus.SUCCEEDED) {
        throw new ConflictException('Le paiement a changé. Actualisez le trajet avant de payer.');
      }
      const amount = Number(booking.paymentAmount);
      const trip = await manager.findOneBy(Trip, { id: booking.tripId });
      if (!trip || trip.driverId === passengerId || !trip.acceptedPaymentModes?.includes(TripPaymentMode.CASH) ||
          !Number.isFinite(amount) || amount <= 0) {
        throw new BadRequestException('Le paiement en espèces n’est pas disponible pour ce trajet.');
      }
      // The provider-insert guard locks this booking too, preventing a late
      // initiation racing the cash choice. Even a previously declined direct
      // collection stays outside this top-up-only escape hatch: a late corrected
      // provider success must remain reconcilable through the existing flow.
      if (await manager.exists(PaymentTransaction, { where: {
        purpose: PaymentPurpose.TRIP_BOOKING, relatedEntityType: 'booking', relatedEntityId: id,
      } }) || await manager.exists(WalletLedgerEntry, { where: {
        userId: passengerId, type: WalletLedgerEntryType.BOOKING_PAYMENT,
        relatedEntityType: 'booking', relatedEntityId: id,
      } })) throw new ConflictException('Un règlement du trajet existe déjà. Vérifiez-le avant de payer en espèces.');

      // Keep fare, subsidy, references and provider history. Existing cash
      // commission triggers still enforce availability and collection rules.
      await manager.query(`UPDATE bookings SET "tokenCashFallbackAt" = now(), "paymentMode" = 'cash',
        "paymentStatus" = 'not_required', "paidAt" = NULL, "updatedAt" = now() WHERE id = $1`, [id]);
      return manager.findOneByOrFail(Booking, { id });
    });
    await this.bookings.invalidateManualRideCaches(id).catch(() => undefined);
    return result;
  }
}
