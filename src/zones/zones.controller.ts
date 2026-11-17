import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Request,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import {
  SaveZoneDto,
  UpdateZoneDto,
  ZonePageDto,
  ZoneSettingsDto,
} from './zones.dto';
import { ZonesService } from './zones.service';

@ApiTags('Admin Zones')
@Controller('admin/zones')
@Auth()
@Roles(UserRole.ADMIN)
@SensitiveThrottle(60, 60000)
export class ZonesController {
  constructor(private readonly zones: ZonesService) {}
  @Get('status') status() {
    return this.zones.status();
  }
  @Get() list(@Query() q: ZonePageDto) {
    return this.zones.list(q);
  }
  @Put('settings')
  @Roles(UserRole.SUPER_ADMIN)
  settings(
    @Request() req: { user: { userId: string } },
    @Body() dto: ZoneSettingsDto,
  ) {
    return this.zones.updateSettings(req.user.userId, dto);
  }
  @Get('events') events(@Query() q: ZonePageDto) {
    return this.zones.events(q);
  }
  @Get('assignments') assignments(@Query() q: ZonePageDto) {
    return this.zones.assignments(q);
  }
  @Get(':id/audit') audit(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ZonePageDto,
  ) {
    return this.zones.audit(id, q);
  }
  @Post()
  @Roles(UserRole.SUPER_ADMIN)
  create(
    @Request() req: { user: { userId: string } },
    @Body() dto: SaveZoneDto,
  ) {
    return this.zones.save(req.user.userId, dto);
  }
  @Put(':id')
  @Roles(UserRole.SUPER_ADMIN)
  update(
    @Request() req: { user: { userId: string } },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateZoneDto,
  ) {
    return this.zones.save(req.user.userId, dto, id);
  }
}
