import { publicTripResponse, tripResponseForViewer } from './trip-read-policy';
import { SanitizedTrip, TripsService } from './trips.service';
import { BookingStatus } from '../bookings/entities/booking.entity';

describe('Trip read privacy', () => {
  const trip = { id: 'trip', driverId: 'driver', isPrivate: true, status: 'ongoing',
    driver: { id: 'driver', phone: 'private-number' }, vehicle: { licensePlate: 'private-plate' },
    driverSafetyEmergencyContactIds: ['private-contact'], currentLocation: { coordinates: [1, 2] },
    bookings: [{ id: 'own', passengerId: 'passenger', status: BookingStatus.ACCEPTED },
      { id: 'other', passengerId: 'other-passenger', status: BookingStatus.ACCEPTED }] } as unknown as SanitizedTrip;
  it('does not expose contact, passenger, tracking or operational data in discovery', () => {
    const json = JSON.stringify(publicTripResponse(trip));
    for (const value of ['private-number', 'private-plate', 'private-contact', 'other-passenger', 'coordinates']) expect(json).not.toContain(value);
  });
  it('denies private detail to an outsider', () => {
    expect(() => tripResponseForViewer(trip, 'outsider', trip)).toThrow('Accès');
  });
  it('keeps only the passenger’s own booking and permits active tracking', () => {
    const result = tripResponseForViewer(trip, 'passenger', trip);
    expect(result.bookings).toEqual([trip.bookings[0]]);
    expect(result.currentLocation).toEqual(trip.currentLocation);
    expect(result).not.toHaveProperty('driverSafetyEmergencyContactIds');
  });
  it('preserves the driver’s management data', () => {
    expect(tripResponseForViewer(trip, 'driver', trip)).toBe(trip);
  });
  it('checks fresh ownership before reading a potentially privileged cached detail', async () => {
    const service: any = Object.create(TripsService.prototype);
    service.tripRepository = { findOne: jest.fn().mockResolvedValue({ ...trip, bookings: [] }) };
    service.findOne = jest.fn().mockResolvedValue(trip);
    await expect(service.findOneForViewer('trip', 'passenger')).rejects.toThrow('Accès');
    expect(service.findOne).not.toHaveBeenCalled();
    service.tripRepository.findOne.mockResolvedValue({ ...trip, bookings: [{ ...trip.bookings[0], status: BookingStatus.CANCELLED }] });
    const result = await service.findOneForViewer('trip', 'passenger');
    expect(result.currentLocation).toBeNull();
    expect(result.driver).not.toHaveProperty('phone');
    expect(result.bookings[0].status).toBe(BookingStatus.CANCELLED);
    expect(service.tripRepository.findOne).toHaveBeenCalledTimes(2);
  });
  it('does not serve cached live coordinates after the trip has ended on the server', () => {
    const result = tripResponseForViewer(trip, 'passenger', { ...trip, status: 'completed' as any });
    expect(result.currentLocation).toBeNull();
    expect(result.status).toBe('completed');
  });
});
