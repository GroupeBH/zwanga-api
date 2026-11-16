import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateDriverLocationDto } from '../../trips/dto/trip.dto';
import { UpdatePassengerLocationDto } from '../../bookings/dto/booking.dto';

describe.each([UpdateDriverLocationDto, UpdatePassengerLocationDto])(
  'GPS batch DTO %p',
  (Dto) => {
    const sample = {
      latitude: -4.3,
      longitude: 15.3,
      accuracy: 5,
      recordedAt: '2026-11-16T10:00:00Z',
    };
    const check = (samples?: unknown) =>
      validate(
        plainToInstance(Dto as typeof UpdateDriverLocationDto, {
          latitude: -4.3,
          longitude: 15.3,
          coordinates: [15.3, -4.3],
          ...(samples === undefined ? {} : { samples }),
        }),
      );
    it('keeps the old contract and accepts ten valid samples', async () => {
      expect(await check()).toHaveLength(0);
      expect(await check(Array(10).fill(sample))).toHaveLength(0);
    });
    it.each([
      Array(11).fill(sample),
      [{ ...sample, latitude: 100 }],
      [{ ...sample, accuracy: -1 }],
      [{ ...sample, recordedAt: 'invalid' }],
      ['invalid'],
    ])('rejects malformed or unbounded history %p', async (samples) => {
      expect((await check(samples)).some((e) => e.property === 'samples')).toBe(
        true,
      );
    });
  },
);
