import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Request,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { FavoritePlacesService } from './favorite-places.service';
import {
  CreateFavoritePlaceDto,
  UpdateFavoritePlaceDto,
  FavoritePlaceResponse,
} from './dto/favorite-place.dto';
import { FavoritePlaceType } from './entities/favorite-place.entity';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';

@ApiTags('Favorite Places')
@Controller('favorite-places')
@Auth()
@ApiBearerAuth()
export class FavoritePlacesController {
  constructor(private readonly favoritePlacesService: FavoritePlacesService) {}

  @Post()
  @SensitiveThrottle(10, 60000) // 10 requests per minute per IP
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new favorite place' })
  @ApiResponse({ status: 201, description: 'Favorite place created successfully', type: FavoritePlaceResponse })
  async create(
    @Request() req,
    @Body() createDto: CreateFavoritePlaceDto,
  ): Promise<FavoritePlaceResponse> {
    return this.favoritePlacesService.create(req.user.userId, createDto);
  }

  @Get()
  @SensitiveThrottle(30, 60000) // 30 requests per minute per IP
  @ApiOperation({ summary: 'Get all favorite places for the current user' })
  @ApiResponse({ status: 200, description: 'Favorite places retrieved successfully', type: [FavoritePlaceResponse] })
  async findAll(@Request() req): Promise<FavoritePlaceResponse[]> {
    return this.favoritePlacesService.findAll(req.user.userId);
  }

  @Get('type/:type')
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get favorite places by type (home, work, other)' })
  @ApiResponse({ status: 200, description: 'Favorite places retrieved successfully', type: [FavoritePlaceResponse] })
  async findByType(
    @Request() req,
    @Param('type') type: FavoritePlaceType,
  ): Promise<FavoritePlaceResponse[]> {
    return this.favoritePlacesService.findByType(req.user.userId, type);
  }

  @Get('default')
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get default favorite place (optionally filtered by type)' })
  @ApiQuery({ name: 'type', required: false, enum: FavoritePlaceType, description: 'Filter by place type' })
  @ApiResponse({ status: 200, description: 'Default favorite place retrieved successfully', type: FavoritePlaceResponse })
  async findDefault(
    @Request() req,
    @Query('type') type?: FavoritePlaceType,
  ): Promise<FavoritePlaceResponse | null> {
    return this.favoritePlacesService.findDefault(req.user.userId, type);
  }

  @Get(':id')
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get a favorite place by ID' })
  @ApiResponse({ status: 200, description: 'Favorite place retrieved successfully', type: FavoritePlaceResponse })
  async findOne(
    @Request() req,
    @Param('id') id: string,
  ): Promise<FavoritePlaceResponse> {
    return this.favoritePlacesService.findOne(id, req.user.userId);
  }

  @Put(':id')
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Update a favorite place' })
  @ApiResponse({ status: 200, description: 'Favorite place updated successfully', type: FavoritePlaceResponse })
  async update(
    @Request() req,
    @Param('id') id: string,
    @Body() updateDto: UpdateFavoritePlaceDto,
  ): Promise<FavoritePlaceResponse> {
    return this.favoritePlacesService.update(id, req.user.userId, updateDto);
  }

  @Put(':id/set-default')
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Set a favorite place as default for its type' })
  @ApiResponse({ status: 200, description: 'Favorite place set as default successfully', type: FavoritePlaceResponse })
  async setAsDefault(
    @Request() req,
    @Param('id') id: string,
  ): Promise<FavoritePlaceResponse> {
    return this.favoritePlacesService.setAsDefault(id, req.user.userId);
  }

  @Delete(':id')
  @SensitiveThrottle(10, 60000)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a favorite place' })
  @ApiResponse({ status: 204, description: 'Favorite place deleted successfully' })
  async remove(
    @Request() req,
    @Param('id') id: string,
  ): Promise<void> {
    return this.favoritePlacesService.remove(id, req.user.userId);
  }
}

