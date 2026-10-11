import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Rating } from './entities/rating.entity';
import { User } from '../users/entities/user.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { CreateRatingDto } from './dto/rating.dto';
import { HistoryPageDto, loadHistoryPage } from '../common/pagination/history-page';

@Injectable()
export class RatingsService {
  private readonly logger = new Logger(RatingsService.name);

  constructor(
    @InjectRepository(Rating)
    private ratingRepository: Repository<Rating>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  async create(raterId: string, dto: CreateRatingDto): Promise<Rating> {
    if (raterId === dto.ratedUserId) throw new BadRequestException('Vous ne pouvez pas vous attribuer une note.');
    if (!await this.userRepository.exists({ where: { id: dto.ratedUserId } })) {
      throw new NotFoundException('La personne à évaluer est introuvable.');
    }
    return this.ratingRepository.manager.transaction(async manager => {
      // Serialize legacy requests without tripId too, before resolving an eligible ride.
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `zwanga:rating:${raterId}:${dto.ratedUserId}`,
      ]);
      const bookings = manager.getRepository(Booking).createQueryBuilder('booking')
        .innerJoin('booking.trip', 'trip')
        .select('booking.tripId', 'tripId')
        .where('booking.status = :completed', { completed: BookingStatus.COMPLETED })
        .andWhere('((trip.driverId = :raterId AND booking.passengerId = :ratedUserId) OR (trip.driverId = :ratedUserId AND booking.passengerId = :raterId))',
          { raterId, ratedUserId: dto.ratedUserId });
      if (dto.tripId) bookings.andWhere('booking.tripId = :tripId', { tripId: dto.tripId });
      else bookings.andWhere('NOT EXISTS (SELECT 1 FROM ratings r WHERE r."tripId" = booking."tripId" AND r."raterId" = :raterId AND r."ratedUserId" = :ratedUserId)');
      const shared = await bookings.orderBy('booking.createdAt', 'DESC').addOrderBy('booking.id', 'DESC').limit(1).getRawOne<{ tripId: string }>();
      if (!shared) throw new BadRequestException('Un trajet effectué ensemble et non encore évalué est requis.');
      const ratings = manager.getRepository(Rating);
      if (await ratings.exists({ where: { raterId, ratedUserId: dto.ratedUserId, tripId: shared.tripId } })) {
        throw new BadRequestException('Vous avez déjà évalué cette personne pour ce trajet.');
      }
      const saved = await ratings.save(ratings.create({ ...dto, raterId, tripId: shared.tripId, verificationVersion: 1 }));
      // Internal constraint marker is not part of the mobile response.
      delete (saved as Partial<Rating>).verificationVersion;
      return saved;
    });
  }

  async findByUser(userId: string): Promise<Rating[]> {
    this.logger.debug(`Fetching ratings for user: ${userId}`);
    
    const ratings = await this.ratingRepository.find({
      where: { ratedUserId: userId },
      relations: ['rater'],
      // The legacy endpoint keeps its array contract, but not private author data.
      select: {
        id: true, ratedUserId: true, raterId: true, tripId: true,
        rating: true, comment: true, createdAt: true, updatedAt: true,
        rater: { id: true, firstName: true, lastName: true, profilePicture: true },
      },
      order: { createdAt: 'DESC' },
    });

    this.logger.debug(`Found ${ratings.length} ratings for user ${userId}`);
    return ratings;
  }

  async findPage(userId: string, options: HistoryPageDto) {
    const query = this.ratingRepository.createQueryBuilder('entry')
      .leftJoin('entry.rater', 'rater')
      .select(['entry.id', 'entry.ratedUserId', 'entry.raterId', 'entry.tripId',
        'entry.rating', 'entry.comment', 'entry.createdAt',
        'rater.id', 'rater.firstName', 'rater.lastName', 'rater.profilePicture'])
      .where('entry.ratedUserId = :userId', { userId });
    return loadHistoryPage(query, options);
  }

  async getUserAverageRating(userId: string): Promise<number> {
    this.logger.debug(`Calculating average rating for user: ${userId}`);
    
    const result = await this.ratingRepository
      .createQueryBuilder('rating')
      .select('AVG(rating.rating)', 'average')
      .where('rating.ratedUserId = :userId', { userId })
      .getRawOne();

    const average = result?.average ? parseFloat(result.average) : 0;
    this.logger.debug(`Average rating for user ${userId}: ${average.toFixed(2)}`);
    return average;
  }
}

