import { Controller, Get, Post, Body, Param, Request } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { RatingsService } from './ratings.service';
import { CreateRatingDto } from './dto/rating.dto';
import { Auth } from '../auth/decorators/auth.decorator';

@ApiTags('Ratings')
@Controller('ratings')
export class RatingsController {
  constructor(private readonly ratingsService: RatingsService) {}

  @Post()
  @Auth()
  @ApiOperation({ summary: 'Create a rating' })
  async create(@Request() req, @Body() createRatingDto: CreateRatingDto) {
    return this.ratingsService.create(req.user.userId, createRatingDto);
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get ratings for a user' })
  async findByUser(@Param('userId') userId: string) {
    return this.ratingsService.findByUser(userId);
  }

  @Get('user/:userId/average')
  @ApiOperation({ summary: 'Get average rating for a user' })
  async getAverageRating(@Param('userId') userId: string) {
    const average = await this.ratingsService.getUserAverageRating(userId);
    return { userId, averageRating: average };
  }
}

