import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { DriverSettlementsService } from './driver-settlements.service';

@Injectable()
export class CashSubsidyRecoveryService {
  private readonly logger = new Logger(CashSubsidyRecoveryService.name);
  private running = false;
  private cursor: string | null = null;

  constructor(private readonly dataSource: DataSource, private readonly settlements: DriverSettlementsService) {}

  @Cron('*/5 * * * *')
  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Indexed bounded batch, rotating cursor so invalid fares cannot starve later bookings.
      const candidates: { id: string }[] = await this.dataSource.query(`
        SELECT b.id FROM bookings b
        WHERE b."paymentMode" = 'cash' AND b."firstTripSubsidyApplied" = true
          AND b."zwangaSubsidyAmount" > 0
          AND b.status IN ('accepted', 'completed')
          AND (b.status = 'completed' OR b."droppedOff" = true OR b."droppedOffAt" IS NOT NULL)
          AND ($1::uuid IS NULL OR b.id > $1::uuid)
          AND NOT EXISTS (SELECT 1 FROM driver_earnings e WHERE e."bookingId" = b.id)
        ORDER BY b.id LIMIT 50
      `, [this.cursor]);
      this.cursor = candidates.length === 50 ? candidates[candidates.length - 1].id : null;
      let recovered = 0;
      for (const { id } of candidates) {
        try {
          // Re-read/lock the actual booking; never trust the candidate snapshot.
          const earning = await this.settlements.recordCompletedBookingEarning({ id, paymentMode: TripPaymentMode.CASH } as Booking);
          if (earning) recovered += 1;
        } catch (error) {
          this.logger.error(`CASH_SUBSIDY_RECOVERY_FAILED bookingId=${id} reason=${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (candidates.length) this.logger.warn(`CASH_SUBSIDY_RECOVERY inspected=${candidates.length} settled=${recovered}`);
    } catch (error) {
      this.logger.error(`CASH_SUBSIDY_RECOVERY_UNAVAILABLE reason=${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
