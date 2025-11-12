import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Request,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TripsService } from './trips.service';
import { CreateTripDto, SearchTripsDto, UpdateTripDto } from './dto/trip.dto';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('Trips')
@Controller('trips')
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Post()
  @Auth()
  @Roles(UserRole.DRIVER)
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // 10 requests per minute
  @ApiOperation({ summary: 'Create a new trip' })
  async create(@Request() req, @Body() createTripDto: CreateTripDto) {
    return this.tripsService.create(req.user.userId, createTripDto);
  }

  @Get()
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60000 } }) // 30 requests per minute
  @ApiOperation({ summary: 'Get all available trips or search trips' })
  async findAll(@Query() searchTripsDto: SearchTripsDto) {
    if (Object.keys(searchTripsDto).length > 0) {
      return this.tripsService.search(searchTripsDto);
    }
    return this.tripsService.findAll();
  }

  @Get('my-trips')
  @Auth()
  @ApiOperation({ summary: 'Get trips created by current user' })
  async findMyTrips(@Request() req) {
    return this.tripsService.findByDriver(req.user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a trip by ID' })
  async findOne(@Param('id') id: string) {
    return this.tripsService.findOne(id);
  }

  @Put(':id')
  @Auth()
  @ApiOperation({ summary: 'Update a trip' })
  async update(
    @Request() req,
    @Param('id') id: string,
    @Body() updateTripDto: UpdateTripDto,
  ) {
    return this.tripsService.update(id, req.user.userId, updateTripDto);
  }

  @Delete(':id')
  @Auth()
  @ApiOperation({ summary: 'Cancel a trip' })
  async remove(@Request() req, @Param('id') id: string) {
    await this.tripsService.remove(id, req.user.userId);
    return { message: 'Trip cancelled successfully' };
  }
}

