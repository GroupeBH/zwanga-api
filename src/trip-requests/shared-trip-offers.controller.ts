import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Equals, IsBoolean, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import { SharedTripOffersService } from './shared-trip-offers.service';

export class ProposeSharedTripDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Trajet en cours appartenant au conducteur connecté.',
  })
  @IsUUID()
  tripId: string;
}
export class AcceptSharedTripDto {
  @ApiProperty({
    enum: [true],
    description:
      'Accord explicite du passager pour rejoindre un trajet déjà en cours et partagé.',
  })
  @IsBoolean()
  @Equals(true)
  // Global implicit conversion would turn the string "false" into true.
  @Transform(({ obj }) => obj.consent, { toClassOnly: true })
  consent: boolean;
}

@ApiTags('Trip Requests')
@Controller('trip-requests/:requestId/shared-offers')
@Auth()
export class SharedTripOffersController {
  constructor(private readonly offers: SharedTripOffersService) {}

  @Get('context')
  @Roles(UserRole.DRIVER)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'Vérifier si mon trajet en cours peut accueillir cette commande',
  })
  context(@Request() req, @Param('requestId', ParseUUIDPipe) id: string) {
    return this.offers.context(req.user.userId, id);
  }

  @Post()
  @Roles(UserRole.DRIVER)
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary:
      'Proposer un trajet partagé, sans réserver de place ni assigner le passager',
  })
  propose(
    @Request() req,
    @Param('requestId', ParseUUIDPipe) id: string,
    @Body() body: ProposeSharedTripDto,
  ) {
    return this.offers.propose(req.user.userId, id, body.tripId);
  }

  @Post(':offerId/accept')
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary:
      'Consentir au partage et réserver atomiquement les places disponibles',
  })
  accept(
    @Request() req,
    @Param('requestId', ParseUUIDPipe) id: string,
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Body() body: AcceptSharedTripDto,
  ) {
    return this.offers.accept(req.user.userId, id, offerId, body.consent);
  }

  @Post(':offerId/decline')
  @SensitiveThrottle(10, 60000)
  @ApiOperation({
    summary: 'Refuser le partage tout en conservant sa commande ouverte',
  })
  decline(
    @Request() req,
    @Param('requestId', ParseUUIDPipe) id: string,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ) {
    return this.offers.decline(req.user.userId, id, offerId);
  }
}
