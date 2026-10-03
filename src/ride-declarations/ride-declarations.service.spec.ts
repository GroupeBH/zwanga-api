import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { BookingsService } from '../bookings/bookings.service';
import { RideDeclarationsService } from './ride-declarations.service';
import { RideDeclarationDto } from './ride-declaration.dto';

function harness() {
  const booking = { id: 'booking', tripId: 'trip', passengerId: 'passenger', status: BookingStatus.ACCEPTED, rideDeclarations: {}, pickedUp: false, droppedOff: false } as unknown as Booking;
  const trip = { id: 'trip', driverId: 'driver', status: TripStatus.ACTIVE, startedAt: new Date(Date.now() - 60_000) } as Trip;
  const locks: string[] = [];
  const builder = {
    addSelect: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockImplementation(() => { locks.push('booking'); return builder; }),
    getOne: jest.fn().mockImplementation(async () => structuredClone(booking)),
  };
  const repository = { findOneBy: jest.fn().mockImplementation(async () => ({ ...booking })), createQueryBuilder: jest.fn(() => builder) };
  const manager = {
    findOne: jest.fn().mockImplementation(async () => { locks.push('trip'); return { ...trip }; }),
    getRepository: jest.fn(() => repository),
    update: jest.fn().mockImplementation(async (_entity, _id, patch) => {
      for (const [key, value] of Object.entries(patch)) {
        if (typeof value !== 'function') booking[key] = value;
      }
      booking.rideEffectsVersion = (booking.rideEffectsVersion ?? 0) + 1;
      return { affected: 1 };
    }),
  };
  const db = { getRepository: jest.fn(() => repository), transaction: jest.fn(async fn => fn(manager)) };
  const bookings = { validateManualRidePassenger: jest.fn(), invalidateManualRideCaches: jest.fn().mockResolvedValue(undefined), finishManualRideEffects: jest.fn() };
  const service = new RideDeclarationsService(db as unknown as DataSource, bookings as unknown as BookingsService);
  let sequence = 0;
  const dto = (stage: 'pickup' | 'dropoff' = 'pickup', decision: 'confirm' | 'reject' = 'confirm', actorUserId = 'passenger'): RideDeclarationDto => ({ eventId: `event-${++sequence}`, actorUserId, stage, decision, occurredAt: new Date().toISOString() });
  return { booking, trip, locks, manager, bookings, service, dto };
}

describe('manual dual ride transaction', () => {
  for (const stage of ['pickup', 'dropoff'] as const) {
    for (const first of ['passenger', 'driver'] as const) {
      const second = first === 'driver' ? 'passenger' : 'driver';
      it(`${stage}: ${first} then ${second}, exactly one transition and no inline financial effect`, async () => {
        const h = harness();
        if (stage === 'dropoff') h.booking.pickedUp = true;
        const firstEvent = h.dto(stage, 'confirm', first);
        const result = await h.service.declare('booking', first, firstEvent, first);
        expect(result[stage].status).toBe('awaiting_other');
        expect(h.booking[stage === 'pickup' ? 'pickedUp' : 'droppedOff']).toBe(false);
        expect(h.booking.status).toBe(BookingStatus.ACCEPTED);
        expect(h.booking.rideDeclarations[stage]?.[second]).toBeUndefined();
        const count = h.manager.update.mock.calls.length;
        await h.service.declare('booking', first, firstEvent);
        await h.service.declare('booking', first, h.dto(stage, 'confirm', first));
        expect(h.manager.update).toHaveBeenCalledTimes(count);
        const secondEvent = h.dto(stage, 'confirm', second);
        expect((await h.service.declare('booking', second, secondEvent, second))[stage].status).toBe('confirmed');
        expect(h.booking[stage === 'pickup' ? 'pickupDetectionMethod' : 'dropoffDetectionMethod']).toBe('manual_dual_confirmation');
        expect(h.booking[stage === 'pickup' ? 'pickedUpConfirmedByPassenger' : 'droppedOffConfirmedByPassenger']).toBe(true);
        expect(h.booking.status).toBe(stage === 'pickup' ? BookingStatus.ACCEPTED : BookingStatus.COMPLETED);
        expect(h.booking.rideEffectsPending).toEqual([stage]);
        expect(h.bookings.finishManualRideEffects).not.toHaveBeenCalled();
        const appliedCount = h.manager.update.mock.calls.length;
        await h.service.declare('booking', second, secondEvent);
        await h.service.declare('booking', first, firstEvent);
        expect(h.manager.update).toHaveBeenCalledTimes(appliedCount);
        expect(h.locks.slice(0, 2)).toEqual(['trip', 'booking']);
      });
    }
    it(`${stage}: rejects a stranger and a mismatched role`, async () => {
      for (const actor of ['stranger', 'driver']) {
        const h = harness(); h.booking.pickedUp = stage === 'dropoff';
        await expect(h.service.declare('booking', actor, h.dto(stage, 'confirm', actor), 'passenger'))
          .rejects.toBeInstanceOf(ForbiddenException);
        expect(h.manager.update).not.toHaveBeenCalled();
      }
    });
    it(`${stage}: a lone provisional vote still waits; a ready pair can be replayed once without rewriting evidence`, async () => {
      const h = harness(); h.booking.pickedUp = stage === 'dropoff';
      const event = h.dto(stage);
      const passenger = { ...event, receivedAt: event.occurredAt };
      h.booking.rideDeclarations = { [stage]: { passenger } };
      expect((await h.service.declare('booking', 'passenger', event))[stage].status).toBe('awaiting_other');
      expect(h.manager.update).not.toHaveBeenCalled();
      const driverEvent = h.dto(stage, 'confirm', 'driver');
      h.booking.rideDeclarations[stage]!.driver = { ...driverEvent, receivedAt: driverEvent.occurredAt };
      expect((await h.service.declare('booking', 'passenger', event))[stage].status).toBe('confirmed');
      expect(h.booking.rideDeclarations[stage]!.passenger).toEqual(passenger);
      await h.service.declare('booking', 'driver', driverEvent);
      expect(h.manager.update).toHaveBeenCalledTimes(1);
    });
    it(`${stage}: a fresh ID cannot redate an expired ready receipt`, async () => {
      const h = harness(); h.booking.pickedUp = stage === 'dropoff';
      const event = h.dto(stage), driver = h.dto(stage, 'confirm', 'driver');
      h.booking.rideDeclarations = { [stage]: {
        passenger: { ...event, occurredAt: new Date(Date.now() - 73 * 3600_000).toISOString(), receivedAt: event.occurredAt },
        driver: { ...driver, receivedAt: driver.occurredAt },
      } };
      await expect(h.service.declare('booking', 'passenger', h.dto(stage)))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'RIDE_EVENT_TIME' }) });
      expect(h.manager.update).not.toHaveBeenCalled();
    });
    it(`${stage}: automatic confirmation wins over late taps from either party`, async () => {
      const h = harness(); h.booking.pickedUp = true;
      h.booking.pickupDetectionMethod = 'automatic_shared_movement';
      if (stage === 'dropoff') {
        h.booking.droppedOff = true; h.booking.status = BookingStatus.COMPLETED;
        h.booking.dropoffDetectionMethod = 'automatic_proximity';
      }
      for (const actor of ['passenger', 'driver']) {
        expect((await h.service.declare('booking', actor, h.dto(stage, 'confirm', actor)))[stage].status).toBe('confirmed');
      }
      expect(h.manager.update).not.toHaveBeenCalled();
      expect(h.booking.pickupDetectionMethod).toBe('automatic_shared_movement');
      if (stage === 'dropoff') expect(h.booking.dropoffDetectionMethod).toBe('automatic_proximity');
    });
  }
  it('rejects a changed account token before any database work', async () => {
    const h = harness();
    await expect(h.service.declare('booking', 'driver', h.dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.manager.findOne).not.toHaveBeenCalled();
  });
  it('validates identity before either actor can record pickup', async () => {
    for (const actor of ['passenger', 'driver']) {
      const h = harness(); h.bookings.validateManualRidePassenger.mockRejectedValueOnce(new ForbiddenException());
      await expect(h.service.declare('booking', actor, h.dto('pickup', 'confirm', actor))).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.manager.update).not.toHaveBeenCalled();
    }
  });
  it('rejects arrival before final pickup, then completes only after both arrival votes', async () => {
    const h = harness();
    await h.service.declare('booking', 'passenger', h.dto());
    await expect(h.service.declare('booking', 'passenger', h.dto('dropoff'))).rejects.toBeInstanceOf(ConflictException);
    await h.service.declare('booking', 'driver', h.dto('pickup', 'confirm', 'driver'));
    expect((await h.service.declare('booking', 'passenger', h.dto('dropoff'))).dropoff.status).toBe('awaiting_other');
    expect(h.booking.status).toBe(BookingStatus.ACCEPTED);
    await h.service.declare('booking', 'driver', h.dto('dropoff', 'confirm', 'driver'));
    expect(h.booking.status).toBe(BookingStatus.COMPLETED);
    expect(h.booking.rideEffectsPending).toEqual(['pickup', 'dropoff']);
    expect(h.bookings.finishManualRideEffects).not.toHaveBeenCalled();
  });
  it('a rejection never completes the booking or triggers payment', async () => {
    const h = harness(); h.booking.pickedUp = true;
    await h.service.declare('booking', 'driver', h.dto('dropoff', 'confirm', 'driver'));
    const result = await h.service.declare('booking', 'passenger', h.dto('dropoff', 'reject'));
    expect(result.dropoff.status).toBe('disputed'); expect(h.booking.droppedOff).toBe(false);
    expect(h.bookings.finishManualRideEffects).not.toHaveBeenCalled();
  });
  it('rejects cancelled trips and timestamps before the ride', async () => {
    const h = harness(); h.trip.status = TripStatus.CANCELLED;
    await expect(h.service.declare('booking', 'passenger', h.dto())).rejects.toBeInstanceOf(ConflictException);
    h.trip.status = TripStatus.ACTIVE;
    await expect(h.service.declare('booking', 'passenger', { ...h.dto(), occurredAt: new Date(Date.now() - 3600_000).toISOString() }))
      .rejects.toBeInstanceOf(ConflictException);
  });
});

describe('committed manual ride side effects', () => {
  it('a lone declaration only notifies the other actor, never settles or announces final pickup', async () => {
    for (const stage of ['pickup', 'dropoff'] as const) {
      const booking = { id: 'booking', pickedUp: stage === 'dropoff', droppedOff: false };
      const context = { bookingRepository: { findOne: jest.fn().mockResolvedValue(booking) },
        notifyManualRideDeclaration: jest.fn(), settlePaymentAfterArrival: jest.fn(),
        notifySelectedEmergencyContacts: jest.fn() };
      await BookingsService.prototype.finishManualRideEffects.call(context, 'booking', stage);
      expect(context.notifyManualRideDeclaration).toHaveBeenCalledWith(booking, stage);
      expect(context.settlePaymentAfterArrival).not.toHaveBeenCalled();
      expect(context.notifySelectedEmergencyContacts).not.toHaveBeenCalled();
    }
  });
  it('the retired driver dropoff service cannot bypass the dual-confirmation rule', async () => {
    await expect(BookingsService.prototype.confirmDropoff.call({}, 'booking', 'driver'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'RIDE_DECLARATION_REQUIRED' }) });
  });
  it('manual dual dropoff retains the existing settlement and notification worker', async () => {
    const booking = { id: 'booking', tripId: 'trip', droppedOff: true, dropoffDetectionMethod: 'manual_dual_confirmation' };
    const context = { bookingRepository: { findOne: jest.fn().mockResolvedValue(booking) }, settlePaymentAfterArrival: jest.fn(),
      notifySelectedEmergencyContacts: jest.fn(), notifyPassengerAboutAutomaticDropoffConfirmation: jest.fn(),
      notifyDriverAboutAutomaticDropoffConfirmation: jest.fn(), touchTripInteraction: jest.fn(), invalidateBookingCaches: jest.fn() };
    await BookingsService.prototype.finishManualRideEffects.call(context, 'booking', 'dropoff');
    expect(context.settlePaymentAfterArrival).toHaveBeenCalledWith(booking);
    expect(context.notifyDriverAboutAutomaticDropoffConfirmation).toHaveBeenCalledWith(booking);
    expect(context.invalidateBookingCaches).toHaveBeenCalledTimes(1);
  });
  it('the retired direct driver service cannot bypass the dual-confirmation rule', async () => {
    await expect(BookingsService.prototype.confirmPickup.call({}, 'booking', 'driver'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'RIDE_DECLARATION_REQUIRED' }) });
  });
  it('keeps pickup notifications and cache refresh but never settles arrival payment', async () => {
    const context = { bookingRepository: { findOne: jest.fn().mockResolvedValue({ id: 'booking', tripId: 'trip', pickedUp: true, pickupDetectionMethod: 'manual_passenger_confirmation' }) },
      notifySelectedEmergencyContacts: jest.fn(), notifyDriverEmergencyContactsOnPickup: jest.fn(),
      notifyPassengerAboutAutomaticPickupConfirmation: jest.fn(), notifyDriverAboutAutomaticPickupConfirmation: jest.fn(),
      touchTripInteraction: jest.fn(), invalidateBookingCaches: jest.fn(), settlePaymentAfterArrival: jest.fn() };
    await BookingsService.prototype.finishManualRideEffects.call(context, 'booking', 'pickup');
    expect(context.notifySelectedEmergencyContacts).toHaveBeenCalledWith(expect.anything(), 'pickup');
    expect(context.notifyDriverAboutAutomaticPickupConfirmation).toHaveBeenCalledTimes(1);
    expect(context.invalidateBookingCaches).toHaveBeenCalledTimes(1);
    expect(context.settlePaymentAfterArrival).not.toHaveBeenCalled();
  });
});

describe('durable ride follow-up worker', () => {
  function workerHarness() {
    const repository = {
      find: jest.fn().mockResolvedValue([{ id: 'booking', rideEffectsPending: ['pickup'] }]),
      findOne: jest.fn().mockResolvedValue({ id: 'booking', rideEffectsPending: ['pickup', 'dropoff'], rideEffectsVersion: 4 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const bookings = { finishManualRideEffects: jest.fn().mockResolvedValue(undefined) };
    const service = new RideDeclarationsService({ getRepository: () => repository } as unknown as DataSource, bookings as unknown as BookingsService);
    return { repository, bookings, service };
  }
  it('re-reads the queue after claiming and processes pickup before arrival', async () => {
    const h = workerHarness(); await h.service.repairEffects();
    expect(h.bookings.finishManualRideEffects.mock.calls).toEqual([['booking', 'pickup'], ['booking', 'dropoff']]);
    expect(h.repository.update.mock.calls[1][0]).toEqual(expect.objectContaining({ rideEffectsVersion: 4 }));
  });
  it('does not do work if another process owns the claim', async () => {
    const h = workerHarness(); h.repository.update.mockResolvedValueOnce({ affected: 0 });
    await h.service.repairEffects(); expect(h.bookings.finishManualRideEffects).not.toHaveBeenCalled();
  });
  it('does not clear pending effects if settlement or notification fails', async () => {
    const h = workerHarness(); h.bookings.finishManualRideEffects.mockRejectedValueOnce(new Error('temporary outage'));
    await h.service.repairEffects(); expect(h.repository.update).toHaveBeenCalledTimes(1);
  });
  it('reschedules a changed version instead of clearing newly queued arrival effects', async () => {
    const h = workerHarness(); h.repository.update.mockResolvedValueOnce({ affected: 1 }).mockResolvedValueOnce({ affected: 0 });
    await h.service.repairEffects(); expect(h.repository.update).toHaveBeenCalledTimes(3);
    expect(h.repository.update.mock.calls[2][1]).toEqual({ rideEffectsRetryAt: expect.any(Date) });
  });
});
