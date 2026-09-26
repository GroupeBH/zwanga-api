import { BadRequestException, NotFoundException } from '@nestjs/common';
import { User } from '../users/entities/user.entity';
import { Trip } from './entities/trip.entity';
import { assertDriverPublicationPhoto, savePublicationsWithPhotoPolicy } from './trip-publication-photo';

const trip = () => ({ driverId: 'driver', isPrivate: false } as Trip);
function setup(overrides: Partial<User> = {}, history = false) {
  const driver = { id: 'driver', profilePicture: '', hasPublishedTrip: false, ...overrides };
  const users = {
    findOne: jest.fn(async () => driver),
    update: jest.fn(async (_id, patch) => Object.assign(driver, patch)),
  };
  const trips = {
    existsBy: jest.fn(async () => history),
    save: jest.fn(async (items: Trip[]) => items.map((item, i) => ({ ...item, id: String(i) }))),
  };
  // Serial transaction mock models the owner lock; this is NOT a PostgreSQL integration test.
  let tail = Promise.resolve();
  const repository = { manager: { transaction: jest.fn((_isolation, work) => {
    const run = tail.then(() => work({ getRepository: entity => entity === User ? users : trips }));
    tail = run.catch(() => undefined);
    return run;
  }) } };
  return { driver, users, trips, repository: repository as any };
}

describe('driver photo publication policy', () => {
  it('allows one public trip without a photo and records it atomically', async () => {
    const ctx = setup();
    const saved = await savePublicationsWithPhotoPolicy(ctx.repository, 'driver', [trip()]);
    expect(saved).toHaveLength(1);
    expect(ctx.driver.hasPublishedTrip).toBe(true);
    expect(ctx.repository.manager.transaction).toHaveBeenCalledWith('READ COMMITTED', expect.any(Function));
    expect(ctx.users.findOne).toHaveBeenCalledWith(expect.objectContaining({ lock: { mode: 'pessimistic_write' } }));
    expect(ctx.trips.existsBy).toHaveBeenCalledWith({ driverId: 'driver', isPrivate: false });
  });

  it('blocks the second publication even if the original trip no longer exists', async () => {
    const ctx = setup({ hasPublishedTrip: true });
    await expect(savePublicationsWithPhotoPolicy(ctx.repository, 'driver', [trip()])).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DRIVER_PROFILE_PHOTO_REQUIRED' }),
    });
    expect(ctx.trips.save).not.toHaveBeenCalled();
  });

  it('checks existing history if the durable flag has not been populated', async () => {
    const ctx = setup({}, true);
    await expect(savePublicationsWithPhotoPolicy(ctx.repository, 'driver', [trip()])).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(['profiles/photo.jpg', 'https://example.test/photo.jpg'])('accepts a stored photo: %s', async profilePicture => {
    const ctx = setup({ profilePicture, hasPublishedTrip: true });
    await expect(savePublicationsWithPhotoPolicy(ctx.repository, 'driver', [trip(), trip()])).resolves.toHaveLength(2);
    expect(ctx.trips.existsBy).not.toHaveBeenCalled();
  });

  it('blocks a recurring batch without publishing its first occurrence', async () => {
    const ctx = setup();
    await expect(savePublicationsWithPhotoPolicy(ctx.repository, 'driver', [trip(), trip()])).rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.trips.save).not.toHaveBeenCalled();
    expect(ctx.users.update).not.toHaveBeenCalled();
  });

  it('rejects blank photos and recurring enrollment without a photo', () => {
    expect(() => assertDriverPublicationPhoto({ profilePicture: '  ' }, true)).toThrow(BadRequestException);
    expect(() => assertDriverPublicationPhoto({ profilePicture: '' }, false)).not.toThrow();
  });

  it('does not consume the allowance when saving the trip fails', async () => {
    const ctx = setup();
    ctx.trips.save.mockRejectedValueOnce(new Error('save failed'));
    await expect(savePublicationsWithPhotoPolicy(ctx.repository, 'driver', [trip()])).rejects.toThrow('save failed');
    expect(ctx.users.update).not.toHaveBeenCalled();
    expect(ctx.driver.hasPublishedTrip).toBe(false);
  });

  it('admits only one concurrent first publication under the simulated owner lock', async () => {
    const ctx = setup();
    const results = await Promise.allSettled([1, 2].map(() => savePublicationsWithPhotoPolicy(ctx.repository, 'driver', [trip()])));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(ctx.trips.save).toHaveBeenCalledTimes(1);
  });

  it('does not bypass a missing owner or accept unrelated/private trips', async () => {
    const ctx = setup();
    ctx.users.findOne.mockResolvedValueOnce(null as any);
    await expect(savePublicationsWithPhotoPolicy(ctx.repository, 'driver', [trip()])).rejects.toBeInstanceOf(NotFoundException);
    for (const payload of [{ ...trip(), isPrivate: true }, { ...trip(), driverId: 'other' }]) {
      await expect(savePublicationsWithPhotoPolicy(ctx.repository, 'driver', [payload])).rejects.toThrow('expects public trips');
    }
    expect(ctx.trips.save).not.toHaveBeenCalled();
  });
});
