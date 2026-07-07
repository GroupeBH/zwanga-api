import { Body, Controller, Get, Param, Post, Request } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { Public } from '../common/decorators/public.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { CreateTripShareLinkDto } from './dto/trip-share.dto';
import { TrackingService } from './tracking.service';

@ApiTags('Tracking')
@Controller('tracking')
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @Post('trips/:tripId/share-links')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({
    summary: 'Create a public tracking link for a trip',
    description:
      "Genere un lien web limite dans le temps pour permettre a un proche de suivre un trajet sans installer l'application.",
  })
  async createTripShareLink(
    @Request() req,
    @Param('tripId') tripId: string,
    @Body() dto: CreateTripShareLinkDto,
  ) {
    return this.trackingService.createTripShareLink(
      req.user.userId,
      tripId,
      dto,
    );
  }

  @Get('public/:token')
  @Public()
  @SensitiveThrottle(120, 60000)
  @ApiOperation({
    summary: 'Read a public trip tracking link',
    description:
      'Retourne les informations publiques de suivi du trajet pour une page web sans authentification.',
  })
  async getPublicTripTracking(@Param('token') token: string) {
    return this.trackingService.getPublicTripTracking(token);
  }
}
