import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Trip } from './entities/trip.entity';

export function assertDriverPublicationPhoto(
  driver: Pick<User, 'profilePicture'>,
  photoRequired: boolean,
): void {
  // profilePicture is either the uploaded object key or an external profile URL.
  if (photoRequired && !driver.profilePicture?.trim()) {
    throw new BadRequestException({
      code: 'DRIVER_PROFILE_PHOTO_REQUIRED',
      error: 'Photo de profil requise',
      message: 'Le conducteur doit ajouter une photo de profil pour publier plusieurs trajets. Elle permet aux passagers de le reconnaître.',
    });
  }
}

/** Save public publications and their durable allowance in one short transaction. */
export async function savePublicationsWithPhotoPolicy(
  repository: Repository<Trip>, driverId: string, trips: Trip[],
): Promise<Trip[]> {
  if (!trips.length) return [];
  if (trips.some(trip => trip.driverId !== driverId || trip.isPrivate)) {
    throw new Error('Publication policy expects public trips belonging to the driver');
  }
  return repository.manager.transaction('READ COMMITTED', async manager => {
    // Every publication path takes the same owner lock first. Concurrent first
    // publications cannot both consume the one-trip allowance without a photo.
    const users = manager.getRepository(User);
    const driver = await users.findOne({
      where: { id: driverId },
      select: ['id', 'profilePicture', 'hasPublishedTrip'],
      lock: { mode: 'pessimistic_write' },
    });
    if (!driver) throw new NotFoundException('Conducteur non trouvé');
    const publications = manager.getRepository(Trip);
    const alreadyPublished = driver.hasPublishedTrip || (
      !driver.profilePicture?.trim() && await publications.existsBy({ driverId, isPrivate: false })
    );
    assertDriverPublicationPhoto(driver, alreadyPublished || trips.length > 1);
    const saved = await publications.save(trips);
    if (!driver.hasPublishedTrip) await users.update(driverId, { hasPublishedTrip: true });
    // No geocoding, notifications or cache I/O while holding the lock.
    return saved;
  });
}
