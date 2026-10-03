import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking, BookingStatus } from './entities/booking.entity';
import { BookingsService } from './bookings.service';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';

@Injectable()
export class CashReceiptsService {
  constructor(
    @InjectRepository(Booking) private readonly repository: Repository<Booking>,
    private readonly bookings: BookingsService,
  ) {}

  async confirm(id: string, driverId: string, amount: number, currency: string): Promise<Booking> {
    const booking = await this.repository.findOne({ where: { id }, relations: ['trip'] });
    if (!booking) throw new NotFoundException('Réservation non trouvée.');
    if (booking.trip?.driverId !== driverId) throw new ForbiddenException('Seul le conducteur de ce trajet peut confirmer le cash reçu.');
    if (booking.paymentMode !== TripPaymentMode.CASH || booking.status !== BookingStatus.COMPLETED || !booking.droppedOff) {
      throw new BadRequestException('La confirmation du cash est disponible après la dépose, pour une réservation payée en cash.');
    }
    if (!Number.isFinite(amount) || amount <= 0 || Number(booking.paymentAmount) !== amount
      || booking.paymentCurrency !== currency) throw new ConflictException('Le montant a changé. Actualisez le trajet avant de confirmer le cash reçu.');
    // A single conditional statement rechecks ownership, fare and mode under PostgreSQL's row lock.
    // COALESCE preserves the original receipt on retries/double taps, including concurrent retries.
    const rows = await this.repository.query(`UPDATE bookings AS b SET
      "cashReceivedAt" = COALESCE(b."cashReceivedAt", CURRENT_TIMESTAMP),
      "cashReceivedByDriverId" = COALESCE(b."cashReceivedByDriverId", $2::uuid),
      "cashReceivedAmount" = COALESCE(b."cashReceivedAmount", b."paymentAmount"),
      "updatedAt" = CURRENT_TIMESTAMP
      FROM trips AS t WHERE b.id = $1::uuid AND t.id = b."tripId" AND t."driverId" = $2::uuid
        AND b.status = 'completed' AND b."droppedOff" = true AND b."paymentMode" = 'cash'
        AND b."paymentStatus" = 'not_required' AND b."paymentAmount" = $3 AND b."paymentCurrency" = $4
      RETURNING b.id`, [id, driverId, amount, currency]);
    // TypeORM's PostgreSQL raw UPDATE returns [rows, affectedCount].
    if (!rows?.[0]?.length) throw new ConflictException('La réservation a changé. Actualisez le trajet puis réessayez.');
    await this.bookings.invalidateManualRideCaches(id);
    // Deliberately NO settlement, transfer, subsidy, wallet credit or external payment call.
    return this.bookings.findOne(id);
  }
}
