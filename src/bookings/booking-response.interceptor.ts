import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { mergeMap } from 'rxjs/operators';
import { Booking } from './entities/booking.entity';
import {
  asRecord,
  bookingResponse,
  BookingResponseAccess,
  isBookingResponse,
} from './booking-response';

@Injectable()
export class BookingResponseInterceptor implements NestInterceptor {
  constructor(
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
  ) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: { userId?: string } }>();
    return next
      .handle()
      .pipe(
        mergeMap((value) => this.present(value, request.user?.userId ?? '')),
      );
  }
  async present(value: unknown, viewer: string): Promise<unknown> {
    const ids = new Set<string>();
    const visit = (item: unknown): void => {
      if (isBookingResponse(item)) {
        ids.add(asRecord(item).id as string);
        return;
      }
      if (Array.isArray(item)) item.forEach(visit);
      else if (item && typeof item === 'object' && !(item instanceof Date))
        Object.values(item).forEach(visit);
    };
    visit(value);
    if (!ids.size) return value;
    // One fresh narrow read per page. A cached acceptance cannot authorize tracking.
    const access = await this.bookings
      .createQueryBuilder('booking')
      .innerJoin('booking.trip', 'trip')
      .select('booking.id', 'id')
      .addSelect('booking.tripId', 'tripId')
      .addSelect('booking.passengerId', 'passengerId')
      .addSelect('booking.status', 'status')
      .addSelect('booking.droppedOff', 'droppedOff')
      .addSelect('booking.droppedOffAt', 'droppedOffAt')
      .addSelect(
        'booking.droppedOffConfirmedByPassenger',
        'droppedOffConfirmedByPassenger',
      )
      .addSelect('trip.driverId', 'driverId')
      .addSelect('trip.status', 'tripStatus')
      .addSelect('trip.departureDate', 'departureDate')
      .addSelect('ST_AsGeoJSON(trip.currentLocation)::json', 'currentLocation')
      .addSelect('trip.lastLocationUpdateAt', 'lastLocationUpdateAt')
      .addSelect(
        'ST_AsGeoJSON(booking.passengerCurrentLocation)::json',
        'passengerCurrentLocation',
      )
      .addSelect(
        'booking.passengerLastLocationUpdateAt',
        'passengerLastLocationUpdateAt',
      )
      .where('booking.id IN (:...ids)', { ids: [...ids] })
      .getRawMany<BookingResponseAccess>();
    const byId = new Map(access.map((row) => [row.id, row]));
    const map = (item: unknown): unknown => {
      if (isBookingResponse(item))
        return bookingResponse(
          item,
          byId.get(asRecord(item).id as string),
          viewer,
        );
      if (Array.isArray(item)) return item.map(map);
      if (item && typeof item === 'object' && !(item instanceof Date))
        return Object.fromEntries(
          Object.entries(item).map(([key, child]) => [key, map(child)]),
        );
      return item;
    };
    return map(value);
  }
}
