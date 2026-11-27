import { canRequestBookingPayment, PaymentRequestService } from './payment-request.service';
import { Booking } from './entities/booking.entity';
const now = Date.parse('2026-11-25T12:00:00Z');
const point = (distance: number) => ({ type: 'Point', coordinates: [15.3, -4.32 + distance / 6_371_000 * 180 / Math.PI] });
const fixture = (distance = 500) => ({ id: 'booking', tripId: 'trip', passengerId: 'p', status: 'accepted', pickedUp: true,
  paymentMode: 'points', paymentStatus: 'pending', paymentAmount: 1000, passengerDestinationPoint: point(0),
  trip: { id: 'trip', driverId: 'd', status: 'ongoing', currentLocation: point(distance), lastLocationUpdateAt: new Date(now) },
}) as unknown as Booking;
describe('driver payment invitation', () => {
  it.each([0, 100, 499, 500])('allows at %s metres from this passenger, not the trip final stop', distance => {
    expect(canRequestBookingPayment(fixture(distance), now)).toBe(true);
  });
  it('rejects 501m, stale GPS, unpaid cash, no boarding and an already active or completed payment', () => {
    expect(canRequestBookingPayment(fixture(501), now)).toBe(false);
    for (const patch of [{ paymentMode: 'cash' }, { paymentStatus: 'succeeded' }, { paymentStatus: 'initiated' },
      { status: 'pending' }, { pickedUp: false }, { paymentAmount: 0 }, { interruptionFareLocked: true },
      { rideDeclarations: { pickup: { driver: { decision: 'reject' } } } }])
      expect(canRequestBookingPayment({ ...fixture(), ...patch } as Booking, now)).toBe(false);
    const b = fixture(); b.trip.lastLocationUpdateAt = new Date(now - 31000);
    expect(canRequestBookingPayment(b, now)).toBe(false);
    b.status = 'completed' as any; b.droppedOff = true;
    expect(canRequestBookingPayment(b, now)).toBe(true);
  });
  it('does not reveal an invitation to an unrelated user', async () => {
    const repo = { findOne: async () => fixture(), manager: { findOne: jest.fn() } } as any;
    await expect(new PaymentRequestService(repo).read('booking', 'other')).rejects.toThrow();
    expect(repo.manager.findOne).not.toHaveBeenCalled();
  });
});
