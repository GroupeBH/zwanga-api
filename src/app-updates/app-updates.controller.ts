import { Body, Controller, Get, Param, Post, Query, Request, BadRequestException } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { AppUpdateClientDto, AppVersionDto, PublishAppReleaseDto } from './app-update.dto';
import { AppUpdatesService } from './app-updates.service';

@Controller('app-updates')
export class AppUpdatesController {
  constructor(private readonly updates: AppUpdatesService) {}
  @Get('latest') @Public() @SensitiveThrottle(60, 60000)
  latest(@Query() input: AppVersionDto) { return this.updates.latest(input); }
  @Post('client') @SensitiveThrottle(20, 60000)
  register(@Request() req: { user: { userId: string } }, @Body() input: AppUpdateClientDto) {
    return this.updates.register(req.user.userId, input);
  }
  @Get('releases') @Roles(UserRole.ADMIN)
  list() { return this.updates.list(); }
  @Post('releases') @Roles(UserRole.ADMIN) @SensitiveThrottle(10, 60000)
  publish(@Request() req: { user: { userId: string } }, @Body() input: PublishAppReleaseDto) {
    return this.updates.publish(req.user.userId, input);
  }
  @Post('releases/:id/withdraw') @Roles(UserRole.ADMIN)
  withdraw(@Param('id') id: string) {
    if (!/^\d{1,18}$/.test(id)) throw new BadRequestException('Annonce invalide.');
    return this.updates.withdraw(id);
  }
}
