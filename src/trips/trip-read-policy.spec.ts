import { isExpiredDeparture, publicTripResponse, tripResponseForViewer } from './trip-read-policy';
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
    expect(tripResponseForViewer(trip, 'driver', trip)).toEqual({ ...trip, isExpired: false });
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
  it.each(['upcoming', 'completed'])('identifies a never-started expired %s departure without disclosing owner data', status => {
    const expired = { ...trip, isPrivate: false, status, startedAt: null,
      departureDate: new Date('2000-01-01T08:00:00Z'), canReprogram: true } as SanitizedTrip;
    const publicView = tripResponseForViewer(expired, 'outsider', expired);
    expect(publicView.isExpired).toBe(true);
    expect(publicView).not.toHaveProperty('canReprogram');
    expect(publicView.driver).not.toHaveProperty('phone');
    expect(publicView.bookings).toEqual([]);
    const ownerView = tripResponseForViewer(expired, 'driver', expired);
    expect(ownerView).toMatchObject({ id: trip.id, isExpired: true, canReprogram: true });
    expect(ownerView.bookings).toEqual(trip.bookings);
  });
  it.each([
    ['ongoing', null, '2000-01-01'], ['cancelled', null, '2000-01-01'],
    ['completed', new Date('2000-01-01'), '2000-01-01'], ['completed', undefined, '2000-01-01'],
    ['upcoming', null, '2099-01-01'], ['upcoming', null, 'invalid'],
  ])('does not mislabel %s with start %s and departure %s', (status, startedAt, departure) => {
    expect(isExpiredDeparture({ ...trip, status, startedAt, departureDate: new Date(departure as string) } as SanitizedTrip)).toBe(false);
  });
  it('uses the current server status even when the detail cache still says upcoming', () => {
    const stale = { ...trip, isPrivate: false, status: 'upcoming', startedAt: null,
      departureDate: new Date('2000-01-01') } as SanitizedTrip;
    const current = { ...stale, status: 'ongoing' } as SanitizedTrip;
    expect(tripResponseForViewer(stale, 'outsider', current).isExpired).toBe(false);
    expect(tripResponseForViewer(stale, 'driver', current).status).toBe('ongoing');
  });
  it('does not confuse a completed ride with an expired departure when the cache predates its start', () => {
    const stale = { ...trip, isPrivate: false, status: 'upcoming', startedAt: null,
      departureDate: new Date('2000-01-01'), canReprogram: true } as SanitizedTrip;
    const current = { ...stale, status: 'completed', startedAt: new Date('2000-01-01T09:00:00Z') } as SanitizedTrip;
    expect(tripResponseForViewer(stale, 'outsider', current).isExpired).toBe(false);
    expect(tripResponseForViewer(stale, 'driver', current).canReprogram).toBe(false);
    const rescheduled = { ...stale, departureDate: new Date('2099-01-01') };
    expect(tripResponseForViewer(stale, 'outsider', rescheduled).isExpired).toBe(false);
  });
});
