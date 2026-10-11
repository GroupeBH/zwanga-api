import { RatingsService } from './ratings.service';
import { Rating } from './entities/rating.entity';

describe('Ratings require a shared completed ride', () => {
  function fixture(
    shared: { tripId: string } | undefined = { tripId: 'trip' },
  ) {
    const query = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(async () => shared),
    };
    const ratings = {
      exists: jest.fn(async () => false),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({ ...value, id: 'rating' })),
    };
    const manager = {
      query: jest.fn(),
      getRepository: jest.fn((type) =>
        type === Rating ? ratings : { createQueryBuilder: () => query },
      ),
    };
    const service = new RatingsService(
      { manager: { transaction: (work: any) => work(manager) } } as never,
      { exists: async () => true } as never,
    );
    return { service, query, ratings, manager };
  }
  it('resolves the latest unreviewed ride for older clients without tripId', async () => {
    const f = fixture();
    const saved = await f.service.create('rater', {
      ratedUserId: 'driver',
      rating: 5,
    });
    expect(saved).toMatchObject({ tripId: 'trip', rating: 5 });
    expect(saved).not.toHaveProperty('verificationVersion');
    expect(f.query.where).toHaveBeenCalledWith('booking.status = :completed', {
      completed: 'completed',
    });
    expect(
      f.query.andWhere.mock.calls.some(([sql]) => sql.includes('NOT EXISTS')),
    ).toBe(true);
    expect(f.ratings.create).toHaveBeenCalledWith(
      expect.objectContaining({ verificationVersion: 1 }),
    );
  });
  it('restricts an explicit trip to the two participants', async () => {
    const f = fixture();
    await f.service.create('rater', {
      ratedUserId: 'driver',
      tripId: 'trip',
      rating: 4,
    });
    expect(f.query.andWhere).toHaveBeenCalledWith('booking.tripId = :tripId', {
      tripId: 'trip',
    });
    expect(f.query.andWhere.mock.calls[0][1]).toEqual({
      raterId: 'rater',
      ratedUserId: 'driver',
    });
  });
  it('refuses unrelated or unfinished rides', async () => {
    const f = fixture();
    f.query.getRawOne.mockResolvedValue(undefined);
    await expect(
      f.service.create('rater', { ratedUserId: 'driver', rating: 5 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.ratings.save).not.toHaveBeenCalled();
  });
  it('refuses an existing historical rating for the same ride', async () => {
    const f = fixture();
    f.ratings.exists.mockResolvedValue(true);
    await expect(
      f.service.create('rater', {
        ratedUserId: 'driver',
        tripId: 'trip',
        rating: 5,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.ratings.save).not.toHaveBeenCalled();
  });
});
