import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Request } from '@nestjs/common';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { RideDeclarationDto } from './ride-declaration.dto';
import { RideDeclarationsService } from './ride-declarations.service';

@Controller('ride-declarations')
@Auth()
export class RideDeclarationsController {
  constructor(private readonly service: RideDeclarationsService) {}
  @Get('trip/:id')
  @SensitiveThrottle(30, 60000)
  trip(@Param('id', ParseUUIDPipe) id: string, @Request() req) { return this.service.getForTrip(id, req.user.userId); }
  @Get('booking/:id')
  @SensitiveThrottle(30, 60000)
  booking(@Param('id', ParseUUIDPipe) id: string, @Request() req) { return this.service.get(id, req.user.userId); }
  @Put('booking/:id')
  @SensitiveThrottle(40, 60000)
  declare(@Param('id', ParseUUIDPipe) id: string, @Request() req, @Body() dto: RideDeclarationDto) {
    return this.service.declare(id, req.user.userId, dto);
  }
}
