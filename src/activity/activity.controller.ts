import { Controller, Get, Header, Request } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { ActivityService } from './activity.service';

@ApiTags('Activity')
@Controller('me/activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  @Auth()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'État léger de l’activité personnelle, sans historique ni données GPS' })
  read(@Request() request: { user: { userId: string } }) {
    // The account comes exclusively from the authenticated session, never request parameters.
    return this.activity.read(request.user.userId);
  }
}
