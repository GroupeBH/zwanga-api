import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { BookingsService } from './bookings.service';
import { CreateBookingDto, UpdateBookingStatusDto } from './dto/booking.dto';
import { Auth } from '../auth/decorators/auth.decorator';

@ApiTags('Bookings')
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post()
  @Auth()
  @ApiOperation({ summary: 'Create a new booking' })
  async create(@Request() req, @Body() createBookingDto: CreateBookingDto) {
    return this.bookingsService.create(req.user.userId, createBookingDto);
  }

  @Get('my-bookings')
  @Auth()
  @ApiOperation({ summary: 'Get all bookings of the current user' })
  async findMyBookings(@Request() req) {
    return this.bookingsService.findAllByPassenger(req.user.userId);
  }

  @Get('trip/:tripId')
  @Auth()
  @ApiOperation({ summary: 'Get all bookings for a trip (driver only)' })
  async findByTrip(@Request() req, @Param('tripId') tripId: string) {
    return this.bookingsService.findAllByTrip(tripId, req.user.userId);
  }

  @Get(':id')
  @Auth()
  @ApiOperation({ summary: 'Get a booking by ID' })
  async findOne(@Param('id') id: string) {
    return this.bookingsService.findOne(id);
  }

  @Put(':id/status')
  @Auth()
  @ApiOperation({ summary: 'Update booking status (driver only)' })
  async updateStatus(
    @Request() req,
    @Param('id') id: string,
    @Body() updateStatusDto: UpdateBookingStatusDto,
  ) {
    return this.bookingsService.updateStatus(id, req.user.userId, updateStatusDto);
  }

  @Put(':id/cancel')
  @Auth()
  @ApiOperation({ summary: 'Cancel a booking' })
  async cancel(@Request() req, @Param('id') id: string) {
    await this.bookingsService.cancel(id, req.user.userId);
    return { message: 'Booking cancelled successfully' };
  }
}

