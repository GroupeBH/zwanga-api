import { allRequestPassengersArrivedAndPaid as paid, completePaidRequestTransaction } from './paid-request-completion';
import { completeTripTransaction } from '../trips/complete-trip-transaction';
import { Booking } from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';

const booking = { id: 'b', tripId: 't', status: 'completed', droppedOff: true, paymentMode: 'electronic',
  paymentStatus: 'succeeded', paymentAmount: 1000 } as Booking;
describe('request arrival and collection gate', () => {
  it('requires arrival and a confirmed electronic or token payment, regardless of order', () => {
    expect(paid([booking])).toBe(true);
    expect(paid([{ ...booking, paymentMode: 'points' } as Booking])).toBe(true);
    for (const patch of [{ status: 'accepted' }, { droppedOff: false }, { paymentStatus: 'pending' },
      { paymentStatus: 'initiated' }, { paymentStatus: 'failed' }]) expect(paid([{ ...booking, ...patch } as Booking])).toBe(false);
  });
  it('cash/mixed cash needs a receipt; a declaration or partial token payment is insufficient', () => {
    const cash = { ...booking, paymentMode: 'cash', paymentStatus: 'not_required', cashDeclaredAt: new Date() } as Booking;
    expect(paid([cash])).toBe(false);
    expect(paid([{ ...cash, paymentStatus: 'succeeded' } as Booking])).toBe(false);
    expect(paid([{ ...cash, cashReceivedAt: new Date() }])).toBe(true);
    for (const paymentAmount of [null, undefined, '', NaN]) expect(paid([{ ...cash, paymentAmount } as Booking])).toBe(false);
    expect(paid([{ ...cash, paymentAmount: 0 }])).toBe(true);
  });
  it('no participants, uncertain boarding and outstanding passengers prevent completion', () => {
    expect(paid([])).toBe(false);
    for (const status of ['pending', 'accepted', 'boarding_uncertain'])
      expect(paid([booking, { ...booking, status } as Booking])).toBe(false);
    expect(paid([booking, { ...booking, status: 'cancelled' } as Booking])).toBe(true);
  });
  function fixture(patch = {}) {
    const trip = { id: 't', driverId: 'd', tripRequestId: 'r', status: 'ongoing', ...patch } as Trip;
    const manager = { query: jest.fn(), find: jest.fn(async () => [booking]), findOne: jest.fn(async () => trip), update: jest.fn() };
    const repository = { manager: { transaction: async cb => cb(manager) } } as any;
    return { trip, manager, repository };
  }
  it('automatically completes a paid request under locks, not a public or already finished ride', async () => {
    const f = fixture(); expect((await completePaidRequestTransaction(f.repository, 't', new Date()))?.status).toBe('completed');
    expect(f.manager.update).toHaveBeenCalledTimes(1);
    expect(await completePaidRequestTransaction(f.repository, 't', new Date())).toBe(null);
    expect(await completePaidRequestTransaction(fixture({ tripRequestId: null }).repository, 't', new Date())).toBe(null);
  });
  it('manual completion cannot bypass payment for a request; public rides retain their existing rule', async () => {
    const f = fixture(); f.manager.find.mockResolvedValue([{ ...booking, paymentStatus: 'pending' } as Booking]);
    await expect(completeTripTransaction(f.repository, 't', 'd', new Date(), () => true)).rejects.toThrow('paiement');
    f.trip.tripRequestId = null as any;
    expect(await completeTripTransaction(f.repository, 't', 'd', new Date(), () => true)).toBe(true);
  });
});
