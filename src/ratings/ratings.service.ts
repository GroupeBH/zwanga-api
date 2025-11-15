import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Rating } from './entities/rating.entity';
import { User } from '../users/entities/user.entity';
import { CreateRatingDto } from './dto/rating.dto';

@Injectable()
export class RatingsService {
  private readonly logger = new Logger(RatingsService.name);

  constructor(
    @InjectRepository(Rating)
    private ratingRepository: Repository<Rating>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  async create(raterId: string, createRatingDto: CreateRatingDto): Promise<Rating> {
    this.logger.log(`Creating rating: User ${raterId} rating user ${createRatingDto.ratedUserId} (Rating: ${createRatingDto.rating})`);
    
    if (raterId === createRatingDto.ratedUserId) {
      this.logger.warn(`Rating creation failed: User ${raterId} tried to rate themselves`);
      throw new BadRequestException('Cannot rate yourself');
    }

    const ratedUser = await this.userRepository.findOne({
      where: { id: createRatingDto.ratedUserId },
    });

    if (!ratedUser) {
      this.logger.warn(`Rating creation failed: User ${createRatingDto.ratedUserId} not found`);
      throw new NotFoundException('User to rate not found');
    }

    // Check if user already rated this user for the same trip
    if (createRatingDto.tripId) {
      const existingRating = await this.ratingRepository.findOne({
        where: {
          raterId,
          ratedUserId: createRatingDto.ratedUserId,
          tripId: createRatingDto.tripId,
        },
      });

      if (existingRating) {
        this.logger.warn(`Rating creation failed: User ${raterId} already rated user ${createRatingDto.ratedUserId} for trip ${createRatingDto.tripId}`);
        throw new BadRequestException('You have already rated this user for this trip');
      }
    }

    const rating = this.ratingRepository.create({
      ...createRatingDto,
      raterId,
    });

    const savedRating = await this.ratingRepository.save(rating);
    
    this.logger.log(`Rating created successfully: ${savedRating.id} - User ${raterId} rated user ${createRatingDto.ratedUserId} with ${createRatingDto.rating} stars`);
    return savedRating;
  }

  async findByUser(userId: string): Promise<Rating[]> {
    this.logger.debug(`Fetching ratings for user: ${userId}`);
    
    const ratings = await this.ratingRepository.find({
      where: { ratedUserId: userId },
      relations: ['rater'],
      order: { createdAt: 'DESC' },
    });

    this.logger.debug(`Found ${ratings.length} ratings for user ${userId}`);
    return ratings;
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

