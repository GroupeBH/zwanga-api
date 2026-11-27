import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Booking, BookingPaymentStatus, BookingStatus } from '../bookings/entities/booking.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
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
    query: jest.fn().mockImplementation(async (_sql, args) => {
      booking.arrivalPrompt = JSON.parse(args[1]); return [];
    }),
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
  const arrivalAssistance = { latestObservation: jest.fn() };
  const service = new RideDeclarationsService(db as unknown as DataSource, bookings as unknown as BookingsService, arrivalAssistance as any);
  let sequence = 0;
  const dto = (stage: 'pickup' | 'dropoff' = 'pickup', decision: 'confirm' | 'reject' = 'confirm', actorUserId = 'passenger'): RideDeclarationDto => ({ eventId: `event-${++sequence}`, actorUserId, stage, decision, occurredAt: new Date().toISOString() });
  return { booking, trip, locks, manager, bookings, service, dto, arrivalAssistance };
}

describe('manual ride transaction', () => {
  for (const stage of ['pickup', 'dropoff'] as const) {
    for (const first of ['passenger', 'driver'] as const) {
      const second = first === 'driver' ? 'passenger' : 'driver';
      it(`${stage}: ${first} then ${second}, exactly one transition and no inline financial effect`, async () => {
        const h = harness();
        if (stage === 'dropoff') h.booking.pickedUp = true;
        const passengerArrival = stage === 'dropoff' && first === 'passenger';
        const firstEvent = h.dto(stage, 'confirm', first);
        const result = await h.service.declare('booking', first, firstEvent, first);
        expect(result[stage].status).toBe(passengerArrival ? 'confirmed' : 'awaiting_other');
        expect(h.booking[stage === 'pickup' ? 'pickedUp' : 'droppedOff']).toBe(passengerArrival);
        expect(h.booking.status).toBe(passengerArrival ? BookingStatus.COMPLETED : BookingStatus.ACCEPTED);
        expect(h.booking.rideDeclarations[stage]?.[second]).toBeUndefined();
        const count = h.manager.update.mock.calls.length;
        await h.service.declare('booking', first, firstEvent);
        await h.service.declare('booking', first, h.dto(stage, 'confirm', first));
        expect(h.manager.update).toHaveBeenCalledTimes(count);
        const secondEvent = h.dto(stage, 'confirm', second);
        expect((await h.service.declare('booking', second, secondEvent, second))[stage].status).toBe('confirmed');
        expect(h.booking[stage === 'pickup' ? 'pickupDetectionMethod' : 'dropoffDetectionMethod'])
          .toBe(passengerArrival ? 'manual_passenger_confirmation' : 'manual_dual_confirmation');
        if (passengerArrival) {
          expect(h.manager.update).toHaveBeenCalledTimes(1);
          expect(h.booking.rideDeclarations.dropoff?.driver).toBeUndefined();
        }
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
    it(`${stage}: a saved receipt can be replayed once when sufficient, without rewriting evidence`, async () => {
      const h = harness(); h.booking.pickedUp = stage === 'dropoff';
      const event = h.dto(stage);
      const passenger = { ...event, receivedAt: event.occurredAt };
      h.booking.rideDeclarations = { [stage]: { passenger } };
      const driverEvent = h.dto(stage, 'confirm', 'driver');
      if (stage === 'pickup') {
        expect((await h.service.declare('booking', 'passenger', event))[stage].status).toBe('awaiting_other');
        expect(h.manager.update).not.toHaveBeenCalled();
        h.booking.rideDeclarations[stage]!.driver = { ...driverEvent, receivedAt: driverEvent.occurredAt };
      }
      expect((await h.service.declare('booking', 'passenger', event))[stage].status).toBe('confirmed');
      expect(h.booking.rideDeclarations[stage]!.passenger).toEqual(passenger);
      await h.service.declare('booking', 'driver', driverEvent);
      expect(h.manager.update).toHaveBeenCalledTimes(1);
      if (stage === 'dropoff') expect(h.booking.rideDeclarations.dropoff?.driver).toBeUndefined();
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
  it('rejects arrival before final pickup, then completes on the passenger arrival alone', async () => {
    const h = harness();
    await h.service.declare('booking', 'passenger', h.dto());
    await expect(h.service.declare('booking', 'passenger', h.dto('dropoff'))).rejects.toBeInstanceOf(ConflictException);
    await h.service.declare('booking', 'driver', h.dto('pickup', 'confirm', 'driver'));
    expect((await h.service.declare('booking', 'passenger', h.dto('dropoff'))).dropoff.status).toBe('confirmed');
    expect(h.booking.rideDeclarations.dropoff?.driver).toBeUndefined();
    expect(h.booking.status).toBe(BookingStatus.COMPLETED);
    expect(h.booking.rideEffectsPending).toEqual(['pickup', 'dropoff']);
    expect(h.bookings.finishManualRideEffects).not.toHaveBeenCalled();
  });
  it('allows dual manual boarding with stale GPS, but never skips pickup to accept arrival', async () => {
    const h = harness();
    const oldLocationTimestamp = new Date(Date.now() - 4_533_000);
    h.trip.lastLocationUpdateAt = oldLocationTimestamp;
    h.trip.currentLocation = null;
    h.booking.passengerCurrentLocation = null;

    await expect(h.service.declare('booking', 'passenger', h.dto('dropoff')))
      .rejects.toMatchObject({ status: 409, response: { code: 'RIDE_PICKUP_REQUIRED' } });
    expect(h.manager.update).not.toHaveBeenCalled();
    await h.service.declare('booking', 'passenger', h.dto('pickup'));
    expect(h.booking.pickedUp).toBe(false);
    await h.service.declare('booking', 'driver', h.dto('pickup', 'confirm', 'driver'));
    expect(h.booking.pickedUp).toBe(true);
    expect(h.booking.pickupDetectionMethod).toBe('manual_dual_confirmation');
    await h.service.declare('booking', 'passenger', h.dto('dropoff'));
    expect(h.booking.status).toBe(BookingStatus.COMPLETED);
    expect(h.trip.lastLocationUpdateAt).toEqual(oldLocationTimestamp);
    expect(h.trip.currentLocation).toBeNull();
    expect(h.bookings.finishManualRideEffects).not.toHaveBeenCalled();
  });

  it('a fresh driver arrival cannot promote an expired passenger receipt', async () => {
    const h = harness(); h.booking.pickedUp = true;
    h.booking.rideDeclarations = { dropoff: { passenger: {
      ...h.dto('dropoff'), occurredAt: new Date(Date.now() - 73 * 3600_000).toISOString(), receivedAt: new Date().toISOString(),
    } } };
    await expect(h.service.declare('booking', 'driver', h.dto('dropoff', 'confirm', 'driver')))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'RIDE_EVENT_TIME' }) });
    expect(h.manager.update).not.toHaveBeenCalled();
  });
  it('passenger arrival immediately passes the payment gate without GPS, driver vote or settlement worker', async () => {
    const h = harness(); h.booking.pickedUp = true;
    h.booking.paymentMode = TripPaymentMode.ELECTRONIC;
    h.booking.paymentStatus = BookingPaymentStatus.PENDING;
    h.booking.paymentAmount = 5000;
    await h.service.declare('booking', 'passenger', h.dto('dropoff'));
    const paymentService = Object.create(BookingsService.prototype) as BookingsService;
    expect(() => paymentService['ensureBookingCanBePaid']({ ...h.booking, trip: h.trip })).not.toThrow();
    expect(h.booking.rideDeclarations.dropoff?.driver).toBeUndefined();
    expect(h.booking.paymentStatus).toBe(BookingPaymentStatus.PENDING);
    expect(h.booking.paymentAmount).toBe(5000);
    expect(h.bookings.finishManualRideEffects).not.toHaveBeenCalled();
  });
  it.each(['pickup', 'dropoff'] as const)('a previous %s dispute cannot be bypassed by passenger arrival', async stage => {
    const h = harness(); h.booking.pickedUp = true;
    h.booking.rideDeclarations = { [stage]: { driver: {
      ...h.dto(stage, 'reject', 'driver'), receivedAt: new Date().toISOString(),
    } } };
    await h.service.declare('booking', 'passenger', h.dto('dropoff'));
    expect(h.booking.status).toBe(BookingStatus.ACCEPTED);
    expect(h.booking.droppedOff).toBe(false);
    expect(h.bookings.finishManualRideEffects).not.toHaveBeenCalled();
  });
  it.each([BookingStatus.CANCELLED, BookingStatus.REJECTED, BookingStatus.PENDING])('passenger arrival cannot complete a %s reservation', async status => {
    const h = harness(); h.booking.pickedUp = true; h.booking.status = status;
    await expect(h.service.declare('booking', 'passenger', h.dto('dropoff')))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'RIDE_STATE_CHANGED' }) });
    expect(h.manager.update).not.toHaveBeenCalled();
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

describe('request-origin manual confirmations', () => {
  it.each(['pickup', 'dropoff'] as const)('%s: driver alone applies once without inventing a passenger vote', async stage => {
    const h = harness(); h.trip.tripRequestId = 'request'; h.booking.pickedUp = stage === 'dropoff';
    const dto = h.dto(stage, 'confirm', 'driver');
    const result = await h.service.declare('booking', 'driver', dto, 'driver');
    expect(result.confirmationMode).toBe('driver_only');
    expect(result[stage].status).toBe('confirmed');
    expect(h.booking[stage === 'pickup' ? 'pickupDetectionMethod' : 'dropoffDetectionMethod']).toBe('manual_driver_confirmation');
    expect(h.booking[stage === 'pickup' ? 'pickedUpConfirmedByPassenger' : 'droppedOffConfirmedByPassenger']).not.toBe(true);
    expect(h.booking.rideDeclarations[stage]?.passenger).toBeUndefined();
    expect(h.booking.rideEffectsPending).toEqual([stage]);
    expect(h.bookings.finishManualRideEffects).not.toHaveBeenCalled();
    await h.service.declare('booking', 'driver', dto);
    await h.service.declare('booking', 'driver', h.dto(stage, 'confirm', 'driver'));
    expect(h.manager.update).toHaveBeenCalledTimes(1);
    expect(h.locks.slice(0, 2)).toEqual(['trip', 'booking']);
  });
  it.each(['pickup', 'dropoff'] as const)('%s: passenger old-client taps and replays are forbidden', async stage => {
    const h = harness(); h.trip.tripRequestId = 'request'; h.booking.pickedUp = stage === 'dropoff';
    const dto = h.dto(stage);
    for (const saved of [false, true]) {
      if (saved) h.booking.rideDeclarations = { [stage]: { passenger: { ...dto, receivedAt: dto.occurredAt } } };
      await expect(h.service.declare('booking', 'passenger', dto, 'passenger'))
        .rejects.toMatchObject({ status: 403, response: { code: 'RIDE_DRIVER_CONFIRMATION_REQUIRED' } });
    }
    expect(h.manager.update).not.toHaveBeenCalled();
  });
  it('driver arrival requires boarding and unlocks payment without changing the amount', async () => {
    const h = harness(); h.trip.tripRequestId = 'request';
    h.booking.paymentMode = TripPaymentMode.ELECTRONIC; h.booking.paymentStatus = BookingPaymentStatus.PENDING; h.booking.paymentAmount = 5000;
    await expect(h.service.declare('booking', 'driver', h.dto('dropoff', 'confirm', 'driver')))
      .rejects.toMatchObject({ response: { code: 'RIDE_PICKUP_REQUIRED' } });
    await h.service.declare('booking', 'driver', h.dto('pickup', 'confirm', 'driver'));
    expect(h.bookings.validateManualRidePassenger).toHaveBeenCalledTimes(1);
    await h.service.declare('booking', 'driver', h.dto('dropoff', 'confirm', 'driver'));
    expect(h.booking.status).toBe(BookingStatus.COMPLETED);
    const service = Object.create(BookingsService.prototype) as BookingsService;
    expect(() => service['ensureBookingCanBePaid']({ ...h.booking, trip: h.trip })).not.toThrow();
    expect(h.booking.paymentAmount).toBe(5000);
    expect(h.booking.paymentStatus).toBe(BookingPaymentStatus.PENDING);
  });
  it.each(['pickup', 'dropoff'] as const)('%s: GPS confirmation still wins a late driver tap', async stage => {
    const h = harness(); h.trip.tripRequestId = 'request'; h.booking.pickedUp = true;
    h.booking.pickupDetectionMethod = 'automatic_shared_movement';
    if (stage === 'dropoff') { h.booking.droppedOff = true; h.booking.status = BookingStatus.COMPLETED; }
    expect((await h.service.declare('booking', 'driver', h.dto(stage, 'confirm', 'driver')))[stage].status).toBe('confirmed');
    expect(h.manager.update).not.toHaveBeenCalled();
  });
  it('retains disputes, KYC, expiry and cancelled-trip checks', async () => {
    const disputed = harness(); disputed.trip.tripRequestId = 'request';
    await disputed.service.declare('booking', 'passenger', disputed.dto('pickup', 'reject'));
    expect((await disputed.service.declare('booking', 'driver', disputed.dto('pickup', 'confirm', 'driver'))).pickup.status).toBe('disputed');
    expect(disputed.booking.pickedUp).toBe(false);
    const h = harness(); h.trip.tripRequestId = 'request';
    h.bookings.validateManualRidePassenger.mockRejectedValueOnce(new ForbiddenException());
    await expect(h.service.declare('booking', 'driver', h.dto('pickup', 'confirm', 'driver'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.declare('booking', 'driver', { ...h.dto('pickup', 'confirm', 'driver'), occurredAt: new Date(Date.now() - 73 * 3600_000).toISOString() }))
      .rejects.toMatchObject({ response: { code: 'RIDE_EVENT_TIME' } });
    h.trip.status = TripStatus.CANCELLED;
    await expect(h.service.declare('booking', 'driver', h.dto('pickup', 'confirm', 'driver')))
      .rejects.toMatchObject({ response: { code: 'RIDE_STATE_CHANGED' } });
    expect(h.manager.update).not.toHaveBeenCalled();
  });
  it.each(['confirmPickupByPassenger', 'confirmDropoffByPassenger'] as const)('%s internal entry cannot bypass request-trip permissions', async method => {
    const context = { logger: { log: jest.fn() }, bookingRepository: { findOne: jest.fn().mockResolvedValue({ trip: { tripRequestId: 'request' } }), save: jest.fn() } };
    await expect(BookingsService.prototype[method].call(context, 'booking', 'passenger'))
      .rejects.toMatchObject({ response: { code: 'RIDE_DRIVER_CONFIRMATION_REQUIRED' } });
    expect(context.bookingRepository.save).not.toHaveBeenCalled();
  });
  it('does not re-evaluate GPS pickup after driver confirmation', async () => {
    const service = Object.create(BookingsService.prototype) as BookingsService;
    await expect(service['tryConfirmAutomaticPickup']({ pickedUp: true, pickedUpConfirmedByPassenger: false,
      pickupDetectionMethod: 'manual_driver_confirmation', status: BookingStatus.ACCEPTED,
      trip: { status: TripStatus.ACTIVE, tripRequestId: 'request' } } as Booking)).resolves.toBeNull();
  });
});

describe('passenger consent to a server-proposed near-destination dropoff', () => {
  function proposed() {
    const h = harness(), now = new Date(); h.trip.tripRequestId = 'request'; h.booking.pickedUp = true;
    h.trip.currentLocation = { type: 'Point', coordinates: [15.3, -4.3+190/111195] };
    h.trip.arrivalPoint = { type: 'Point', coordinates: [15.3, -4.3] }; h.trip.lastLocationUpdateAt = now;
    h.booking.arrivalPrompt = { id: 'prompt', proposedAt: new Date(now.getTime()-1000).toISOString(), expiresAt: new Date(now.getTime()+600000).toISOString() };
    h.arrivalAssistance.latestObservation.mockResolvedValue({ longitude: 15.3, latitude: h.trip.currentLocation.coordinates[1], accuracyMeters: 5, recordedAt: now.toISOString() });
    return { ...h, consent: { ...h.dto('dropoff'), arrivalPromptId: 'prompt' } };
  }
  it('passenger consent at 190m completes once, preserves fare, records the agreement and defers payment effects', async () => {
    const h = proposed(); h.booking.paymentAmount = 7500; h.booking.paymentStatus = BookingPaymentStatus.PENDING;
    h.booking.paymentMode = TripPaymentMode.CASH;
    expect((await h.service.declare('booking', 'passenger', h.consent)).dropoff.status).toBe('confirmed');
    expect(h.booking.dropoffDetectionMethod).toBe('manual_passenger_near_destination');
    expect(h.booking.rideDeclarations.dropoff?.passenger?.arrivalPromptId).toBe('prompt');
    expect(h.booking.rideDeclarations.dropoff?.driver).toBeUndefined();
    expect(h.booking.arrivalPrompt?.acceptedAt).toBeDefined();
    expect(h.booking.paymentAmount).toBe(7500); expect(h.booking.cashReceivedAt).toBeUndefined();
    expect(h.bookings.finishManualRideEffects).not.toHaveBeenCalled();
    h.trip.lastLocationUpdateAt = new Date(0); // Retry is still idempotent after moving away.
    await h.service.declare('booking', 'passenger', h.consent);
    expect(h.manager.update).toHaveBeenCalledTimes(1); expect(h.manager.query).toHaveBeenCalledTimes(1);
  });
  it.each(['missing', 'forged', 'expired', 'far', 'stale', 'inaccurate', 'dispute', 'driver', 'stranger', 'pickup', 'historical'])('rejects %s consent without any write or payment', async reason => {
    const h = proposed(); let actor = 'passenger';
    if (reason === 'missing') h.booking.arrivalPrompt = null;
    if (reason === 'forged') h.consent.arrivalPromptId = 'different';
    if (reason === 'expired') h.booking.arrivalPrompt!.expiresAt = new Date(0).toISOString();
    if (reason === 'far') h.trip.currentLocation!.coordinates[1] = -4.3+201/111195;
    if (reason === 'stale') h.trip.lastLocationUpdateAt = new Date(0);
    if (reason === 'inaccurate') h.arrivalAssistance.latestObservation.mockResolvedValue({ recordedAt: new Date().toISOString(), accuracyMeters: 100 });
    if (reason === 'dispute' || reason === 'historical') h.booking.rideDeclarations = { dropoff: { passenger: { ...h.dto('dropoff', reason === 'dispute' ? 'reject' : 'confirm'), receivedAt: new Date().toISOString() } } };
    if (reason === 'driver' || reason === 'stranger') { actor = reason; h.consent.actorUserId = actor; }
    if (reason === 'pickup') h.consent.stage = 'pickup';
    await expect(h.service.declare('booking', actor, h.consent)).rejects.toThrow();
    expect(h.manager.update).not.toHaveBeenCalled(); expect(h.manager.query).not.toHaveBeenCalled();
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
  it('the retired driver dropoff service cannot bypass passenger confirmation', async () => {
    await expect(BookingsService.prototype.confirmDropoff.call({}, 'booking', 'driver'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'RIDE_DECLARATION_REQUIRED' }) });
  });
  it.each(['manual_dual_confirmation', 'manual_passenger_confirmation', 'manual_driver_confirmation', 'manual_passenger_near_destination'])('%s arrival retains the existing settlement and notification worker', async dropoffDetectionMethod => {
    const booking = { id: 'booking', tripId: 'trip', droppedOff: true, dropoffDetectionMethod };
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
  it.each(['manual_passenger_confirmation', 'manual_driver_confirmation'])('%s keeps pickup notifications and cache refresh but never settles arrival payment', async pickupDetectionMethod => {
    const context = { bookingRepository: { findOne: jest.fn().mockResolvedValue({ id: 'booking', tripId: 'trip', pickedUp: true, pickupDetectionMethod }) },
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
