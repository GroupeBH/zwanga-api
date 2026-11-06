import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RatedTripsDto } from './dto/rated-trips.dto';
import { RatingsController } from './ratings.controller';
import { RatingsService } from './ratings.service';

describe('rated trip lookup boundaries', () => {
  const one = randomUUID(),
    two = randomUUID();
  it('accepts a bounded UUID list and rejects malformed/duplicate/unbounded input', async () => {
    const dto = plainToInstance(RatedTripsDto, { tripIds: `${one},${two}` });
    expect(dto.tripIds).toEqual([one, two]);
    expect(await validate(dto)).toEqual([]);
    for (const tripIds of [
      undefined,
      '',
      [],
      {},
      'not-a-uuid',
      `${one},${one}`,
      Array.from({ length: 101 }, () => randomUUID()),
    ]) {
      expect(
        (await validate(plainToInstance(RatedTripsDto, { tripIds }))).length,
      ).toBeGreaterThan(0);
    }
  });
  it('takes identity from authenticated context, never query parameters', async () => {
    const service = {
      ratedTrips: jest
        .fn()
        .mockResolvedValue({ userId: one, ratedTripIds: [two] }),
    };
    const controller = new RatingsController(service as never);
    await controller.ratedTrips({ user: { userId: one } }, {
      tripIds: [two],
      userId: 'forged',
    } as RatedTripsDto);
    expect(service.ratedTrips).toHaveBeenCalledWith(one, [two]);
    const handler = Object.getOwnPropertyDescriptor(
      RatingsController.prototype,
      'ratedTrips',
    )!.value as object;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('mine/trips');
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
      JwtAuthGuard,
    );
  });
  it('uses one parameterized query for verified interactions, without reading stars/comments', async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      distinct: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ tripId: two }]),
    };
    const repo = { createQueryBuilder: jest.fn(() => query) };
    const service = new RatingsService(repo as never, {} as never);
    expect(await service.ratedTrips(one, [two])).toEqual({
      userId: one,
      ratedTripIds: [two],
    });
    expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(query.where).toHaveBeenCalledWith('rating.raterId = :userId', {
      userId: one,
    });
    expect(query.andWhere).toHaveBeenCalledWith(
      'rating.verificationVersion = 1',
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      'rating.tripId IN (:...tripIds)',
      { tripIds: [two] },
    );
    expect(query.select).toHaveBeenCalledWith('rating.tripId', 'tripId');
    await expect(service.ratedTrips(one, [])).rejects.toThrow();
    await expect(
      service.ratedTrips(
        one,
        Array.from({ length: 101 }, () => two),
      ),
    ).rejects.toThrow();
    expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
  });
});
