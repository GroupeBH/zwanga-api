import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Request,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { TripCoPassengersService } from './trip-co-passengers.service';

@ApiTags('Trips')
@Controller('trips')
export class TripCoPassengersController {
  constructor(private readonly coPassengers: TripCoPassengersService) {}

  @Get(':id/co-passengers')
  @Auth()
  @Header('Cache-Control', 'private, no-store')
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary:
      'Public profile identifiers, first names, avatars and seats, only for confirmed participants of a published trip',
  })
  list(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Request() req: { user: { userId: string } },
  ) {
    return this.coPassengers.list(id, req.user.userId);
  }
}
