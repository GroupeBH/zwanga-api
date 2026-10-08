import { BookingsService } from './bookings.service';
import { CashReceiptsService } from './cash-receipts.service';
import { TripsService } from '../trips/trips.service';
import { BookingStatus } from './entities/booking.entity';
import { TripStatus } from '../trips/entities/trip.entity';

describe('arrival wording without changing ride completion rules', () => {
  it('keeps the automatic arrival event payload while updating its visible title and message', async () => {
    const service: any = Object.create(BookingsService.prototype);
    service.userRepository = { findOne: jest.fn().mockResolvedValue({ fcmToken: 'synthetic-token' }) };
    service.notificationService = { sendNotification: jest.fn().mockResolvedValue(true) };
    service.logger = { error: jest.fn() };
    await service.notifyDriverAboutAutomaticDropoffConfirmation({ id: 'booking', tripId: 'trip', passengerId: 'passenger',
      passenger: { firstName: 'Passager', lastName: 'Test' }, trip: { driverId: 'driver' } });
    expect(service.notificationService.sendNotification).toHaveBeenCalledWith('synthetic-token',
      'Arrivée à destination confirmée', 'L’arrivée à destination de Passager Test a été confirmée automatiquement par GPS.',
      { type: 'dropoff_confirmed_automatically', bookingId: 'booking', tripId: 'trip', passengerId: 'passenger', role: 'driver' }, 'driver');
    expect(service.logger.error).not.toHaveBeenCalled();
  });

  it('still refuses cash receipt before confirmed arrival, with the new wording', async () => {
    const repository = { findOne: jest.fn().mockResolvedValue({ trip: { driverId: 'driver' },
      paymentMode: 'cash', status: BookingStatus.ACCEPTED, droppedOff: false }) };
    const service = new CashReceiptsService(repository as any, {} as any);
    await expect(service.confirm('booking', 'driver', 1000, 'CDF')).rejects.toThrow(
      'La réception du cash peut être confirmée après l’arrivée à destination, pour une réservation payée en cash.');
  });

  it('still refuses trip completion while a passenger arrival is unconfirmed', async () => {
    const service: any = Object.create(TripsService.prototype);
    service.logger = { log: jest.fn(), warn: jest.fn() };
    service.tripRepository = { findOne: jest.fn().mockResolvedValue({ status: TripStatus.ACTIVE,
      bookings: [{ id: 'booking', status: BookingStatus.ACCEPTED, droppedOff: false }] }), update: jest.fn() };
    await expect(service.completeTrip('trip', 'driver')).rejects.toThrow(
      'Impossible de terminer le trajet tant que l’arrivée à destination de tous les passagers acceptés n’a pas été confirmée.');
    expect(service.tripRepository.update).not.toHaveBeenCalled();
  });
});
