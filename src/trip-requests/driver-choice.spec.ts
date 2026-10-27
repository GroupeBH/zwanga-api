import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DriverChoiceQuery } from './dto/driver-choice.dto';
import { CreateTripRequestDto } from './dto/trip-request.dto';
import { assertRequestSnapshot } from './request-edit-policy';
import { assertRequestTarget } from './target-driver-policy';

describe('driver choice boundaries', () => {
  const input = { latitude: '-4.3', longitude: '15.31', vehicleType: 'car', seats: '1' };
  it('converts query numbers and accepts a bounded known-driver search', async () => {
    const query = plainToInstance(DriverChoiceQuery, { ...input, search: 'Conducteur test' });
    expect(await validate(query, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    expect(query.latitude).toBe(-4.3); expect(query.seats).toBe(1);
  });
  it.each([{ latitude: 'bad' }, { longitude: '181' }, { seats: '0' }, { seats: '21' },
    { search: 'a'.repeat(81) }, { vehicleType: 'plane' }, { extra: 'unexpected' }])('rejects invalid search %j', async patch => {
    const query = plainToInstance(DriverChoiceQuery, { ...input, ...patch });
    expect((await validate(query, { whitelist: true, forbidNonWhitelisted: true })).length).toBeGreaterThan(0);
  });
  it('rejects a forged target id while keeping targeting optional', async () => {
    const dto = plainToInstance(CreateTripRequestDto, { targetDriverId: 'not-a-uuid' });
    expect((await validate(dto)).some(error => error.property === 'targetDriverId')).toBe(true);
    delete dto.targetDriverId;
    expect((await validate(dto)).some(error => error.property === 'targetDriverId')).toBe(false);
  });
  it('never grants another driver access to a targeted request', () => {
    expect(() => assertRequestTarget({ targetDriverId: 'chosen' }, 'other')).toThrow();
    expect(() => assertRequestTarget({ targetDriverId: 'chosen' }, 'chosen')).not.toThrow();
    expect(() => assertRequestTarget({ targetDriverId: null }, 'other')).not.toThrow();
  });
  it('detects an audience change under the request lock even at equal timestamp precision', () => {
    const snapshot = { status: 'pending', selectedDriverId: null, tripId: null, updatedAt: new Date(), targetDriverId: 'chosen' };
    expect(() => assertRequestSnapshot({ ...snapshot, targetDriverId: null } as any, snapshot as any)).toThrow();
    expect(() => assertRequestSnapshot(snapshot as any, snapshot as any)).not.toThrow();
  });
});
