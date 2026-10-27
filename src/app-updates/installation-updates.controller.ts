import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Request,
  BadRequestException,
} from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import {
  InstallationUpdateDto,
  UpdateCampaignDto,
} from './installation-update.dto';
import { InstallationUpdatesService } from './installation-updates.service';

@Controller('app-updates')
export class InstallationUpdatesController {
  constructor(private readonly updates: InstallationUpdatesService) {}
  @Put('installations/:id')
  @Public()
  @SensitiveThrottle(20, 60000)
  register(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('x-installation-secret') secret: string | undefined,
    @Body() body: InstallationUpdateDto,
  ) {
    return this.updates.register(id, secret, body);
  }
  @Get('campaigns/preview/:releaseId')
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  preview(@Param('releaseId') id: string) {
    if (!/^\d{1,18}$/.test(id))
      throw new BadRequestException('Version invalide.');
    return this.updates.preview(id);
  }
  @Get('campaigns')
  @Roles(UserRole.ADMIN)
  list() {
    return this.updates.list();
  }
  @Post('campaigns')
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(5, 60000)
  create(
    @Request() request: { user: { userId: string } },
    @Body() body: UpdateCampaignDto,
  ) {
    return this.updates.create(request.user.userId, body);
  }
  @Post('campaigns/:id/withdraw')
  @Roles(UserRole.ADMIN)
  withdraw(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.updates.withdraw(id);
  }
}
