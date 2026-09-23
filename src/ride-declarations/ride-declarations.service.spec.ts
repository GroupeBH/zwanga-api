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

describe('manual ride transaction', () => {
  it('rejects an event replayed with a different account token before any database work', async () => {
    const h = harness(); await expect(h.service.declare('booking', 'driver', h.dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.manager.findOne).not.toHaveBeenCalled();
  });
  it('authorizes before recording; another account cannot confirm for a passenger', async () => {
    const h = harness(); await expect(h.service.declare('booking', 'stranger', h.dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.manager.update).not.toHaveBeenCalled();
  });
  it('keeps a single declaration provisional without payment or pickup flags', async () => {
    const h = harness(); const result = await h.service.declare('booking', 'passenger', h.dto());
    expect(result.pickup.status).toBe('awaiting_other'); expect(h.booking.pickedUp).toBe(false);
    expect(h.bookings.finishManualRideEffects).not.toHaveBeenCalled(); expect(h.locks).toEqual(['trip', 'booking']);
  });
  it('validates identity requirements before pickup', async () => {
    const h = harness(); h.bookings.validateManualRidePassenger.mockRejectedValueOnce(new ForbiddenException());
    await expect(h.service.declare('booking', 'passenger', h.dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.manager.update).not.toHaveBeenCalled();
  });
  it('sets final flags only after two distinct parties, with a durable follow-up', async () => {
    const h = harness(); await h.service.declare('booking', 'driver', h.dto('pickup', 'confirm', 'driver'));
    const second = h.dto(); const result = await h.service.declare('booking', 'passenger', second);
    expect(result.pickup.status).toBe('confirmed'); expect(h.booking.pickedUp).toBe(true);
    expect(h.booking.rideEffectsPending).toEqual(['pickup']);
    expect(h.bookings.finishManualRideEffects).not.toHaveBeenCalled();
    const count = h.manager.update.mock.calls.length;
    await h.service.declare('booking', 'passenger', second); expect(h.manager.update).toHaveBeenCalledTimes(count);
  });
  it('rejects arrival before pickup; after pickup the first arrival vote does not complete or charge', async () => {
    const h = harness(); await expect(h.service.declare('booking', 'passenger', h.dto('dropoff'))).rejects.toBeInstanceOf(ConflictException);
    await h.service.declare('booking', 'driver', h.dto('pickup', 'confirm', 'driver')); await h.service.declare('booking', 'passenger', h.dto());
    await h.service.declare('booking', 'passenger', h.dto('dropoff'));
    expect(h.booking.status).toBe(BookingStatus.ACCEPTED); expect(h.booking.droppedOff).toBe(false);
    await h.service.declare('booking', 'driver', h.dto('dropoff', 'confirm', 'driver'));
    expect(h.booking.status).toBe(BookingStatus.COMPLETED); expect(h.booking.rideEffectsPending).toEqual(['pickup', 'dropoff']);
  });
  it('does not turn a rejection into an automatic payment or completion', async () => {
    const h = harness(); h.booking.pickedUp = true;
    await h.service.declare('booking', 'driver', h.dto('dropoff', 'confirm', 'driver'));
    const result = await h.service.declare('booking', 'passenger', h.dto('dropoff', 'reject'));
    expect(result.dropoff.status).toBe('disputed'); expect(h.booking.droppedOff).toBe(false);
    expect(h.bookings.finishManualRideEffects).not.toHaveBeenCalled();
  });
  it('rejects actions after cancellation and actions timestamped before the ride', async () => {
    const h = harness(); h.trip.status = TripStatus.CANCELLED;
    await expect(h.service.declare('booking', 'passenger', h.dto())).rejects.toBeInstanceOf(ConflictException);
    h.trip.status = TripStatus.ACTIVE;
    await expect(h.service.declare('booking', 'passenger', { ...h.dto(), occurredAt: new Date(Date.now() - 3600_000).toISOString() })).rejects.toBeInstanceOf(ConflictException);
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
