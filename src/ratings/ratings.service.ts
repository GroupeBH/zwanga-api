import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Rating } from './entities/rating.entity';
import { User } from '../users/entities/user.entity';
import { CreateRatingDto } from './dto/rating.dto';

@Injectable()
export class RatingsService {
  constructor(
    @InjectRepository(Rating)
    private ratingRepository: Repository<Rating>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  async create(raterId: string, createRatingDto: CreateRatingDto): Promise<Rating> {
    if (raterId === createRatingDto.ratedUserId) {
      throw new BadRequestException('Cannot rate yourself');
    }

    const ratedUser = await this.userRepository.findOne({
      where: { id: createRatingDto.ratedUserId },
    });

    if (!ratedUser) {
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
        throw new BadRequestException('You have already rated this user for this trip');
      }
    }

    const rating = this.ratingRepository.create({
      ...createRatingDto,
      raterId,
    });

    return await this.ratingRepository.save(rating);
  }

  async findByUser(userId: string): Promise<Rating[]> {
    return this.ratingRepository.find({
      where: { ratedUserId: userId },
      relations: ['rater'],
      order: { createdAt: 'DESC' },
    });
  }

  async getUserAverageRating(userId: string): Promise<number> {
    const result = await this.ratingRepository
      .createQueryBuilder('rating')
      .select('AVG(rating.rating)', 'average')
      .where('rating.ratedUserId = :userId', { userId })
      .getRawOne();

    return result?.average ? parseFloat(result.average) : 0;
  }
}

