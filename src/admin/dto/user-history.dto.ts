import { IsIn, IsOptional } from 'class-validator';

export class AdminUserDetailsQuery {
  @IsOptional() @IsIn(['summary'])
  view?: 'summary';
}

export enum AdminUserHistoryKind {
  TRIPS = 'trips',
  PASSENGER_BOOKINGS = 'bookings-passenger',
  DRIVER_BOOKINGS = 'bookings-driver',
  PAYMENTS = 'payments',
  REQUESTS = 'requests',
}
