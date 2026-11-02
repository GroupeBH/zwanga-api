import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VehicleType } from '../vehicles/entities/vehicle.entity';
import { CreateTripRequestDto, UpdateTripRequestDto } from './dto/trip-request.dto';
import { DriverChoiceQuery } from './dto/driver-choice.dto';
import { requestAcceptsVehicle, requestVehicleTypes, resolveRequestVehicleTypes } from './request-vehicle-types';
import { TripRequestsService } from './trip-requests.service';
import { SequentialDispatchService } from './dispatch/sequential-dispatch.service';

const car = VehicleType.CAR, moto = VehicleType.MOTORCYCLE_TWO_WHEELS, tricycle = VehicleType.MOTORCYCLE_THREE_WHEELS;
const base = { departureLocation: 'A', arrivalLocation: 'B', departureDateMin: '2030-01-01T12:00:00Z',
  departureDateMax: '2030-01-01T13:00:00Z', numberOfSeats: 1, maxPricePerSeat: 1500 };

describe('request accepted vehicle types', () => {
  it('invalidates candidate rankings when secondary choices change', () => {
    const relay = Object.create(SequentialDispatchService.prototype) as any;
    expect(relay.queueVersion({ vehicleType: car, vehicleTypes: [car, moto] }))
      .not.toBe(relay.queueVersion({ vehicleType: car, vehicleTypes: [car, tricycle] }));
    expect(relay.queueVersion({ vehicleType: car })).toBe(relay.queueVersion({ vehicleType: car, vehicleTypes: [car] }));
  });
  it('keeps old requests and clients strictly single-type', () => {
    expect(requestVehicleTypes({ vehicleType: moto, vehicleTypes: null })).toEqual([moto]);
    expect(resolveRequestVehicleTypes({ vehicleType: moto })).toEqual([moto]);
    expect(requestAcceptsVehicle({ vehicleType: car }, moto)).toBe(false);
  });
  it('accepts any selected type but never a non-selected type', () => {
    const request = { vehicleType: car, vehicleTypes: [car, moto] };
    expect(requestAcceptsVehicle(request, car)).toBe(true);
    expect(requestAcceptsVehicle(request, moto)).toBe(true);
    expect(requestAcceptsVehicle(request, tricycle)).toBe(false);
    const copy = requestVehicleTypes(request); copy.pop();
    expect(request.vehicleTypes).toEqual([car, moto]);
  });
  it('preserves choices on unrelated edits and replaces them on explicit legacy edits', () => {
    const old = { vehicleType: car, vehicleTypes: [car, moto] };
    expect(resolveRequestVehicleTypes({}, old)).toEqual([car, moto]);
    expect(resolveRequestVehicleTypes({ vehicleType: car }, old)).toEqual([car]);
    expect(resolveRequestVehicleTypes({ vehicleTypes: [moto, tricycle] }, old)).toEqual([moto, tricycle]);
    expect(() => resolveRequestVehicleTypes({ vehicleType: car, vehicleTypes: [moto] })).toThrow();
  });
  it.each([[], null, ['invalid'], [car, car], [car, moto, tricycle, car], car])('rejects invalid selections %j', async types => {
    expect(() => resolveRequestVehicleTypes({ vehicleTypes: types as any })).toThrow();
    for (const Dto of [CreateTripRequestDto, UpdateTripRequestDto]) {
      const errors = await validate(plainToInstance(Dto as typeof CreateTripRequestDto, { ...base, vehicleTypes: types }));
      expect(errors.some(error => error.property === 'vehicleTypes')).toBe(true);
    }
  });
  it.each([{ vehicleType: car }, { vehicleTypes: [car, moto] }, { vehicleType: car, vehicleTypes: [car, moto, tricycle] }])(
    'accepts the legacy and new creation contracts %j', async selection => {
      expect(await validate(plainToInstance(CreateTripRequestDto, { ...base, ...selection }))).toHaveLength(0);
    });
  it('requires a choice on creation and parses array query parameters', async () => {
    expect((await validate(plainToInstance(CreateTripRequestDto, base))).some(e => e.property === 'vehicleType')).toBe(true);
    const query = plainToInstance(DriverChoiceQuery, { latitude: '-4.3', longitude: '15.31', vehicleTypes: `${car},${moto}` });
    expect(await validate(query)).toHaveLength(0);
    expect(resolveRequestVehicleTypes(query)).toEqual([car, moto]);
  });
  it('checks actual vehicle membership during acceptance', () => {
    const service = new TripRequestsService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
    const request = { vehicleType: car, vehicleTypes: [car, moto], numberOfSeats: 1 };
    expect(() => service.assertVehicleMatchesTripRequest({ type: moto }, request)).not.toThrow();
    expect(() => service.assertVehicleMatchesTripRequest({ type: tricycle }, request)).toThrow('Cette commande accepte');
  });
});
