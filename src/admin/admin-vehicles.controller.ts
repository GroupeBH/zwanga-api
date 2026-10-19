import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Request,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminVehiclesService } from './admin-vehicles.service';
import {
  AdminUpdateVehicleDto,
  AdminVehiclesQueryDto,
} from './dto/admin-vehicles.dto';

interface AdminRequest {
  user: { userId: string };
}

@ApiTags('Admin')
@Controller('admin/vehicles')
@Auth()
@Roles(UserRole.ADMIN)
export class AdminVehiclesController {
  constructor(private readonly vehicles: AdminVehiclesService) {}

  @Get()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary:
      'List platform vehicles with owner details, type/status filters and pagination',
  })
  list(@Request() req: AdminRequest, @Query() query: AdminVehiclesQueryDto) {
    return this.vehicles.list(req.user.userId, query);
  }

  @Get(':vehicleId')
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get an active or inactive vehicle as admin' })
  get(
    @Request() req: AdminRequest,
    @Param('vehicleId', ParseUUIDPipe) id: string,
  ) {
    return this.vehicles.get(req.user.userId, id);
  }

  @Put(':vehicleId')
  @SensitiveThrottle(10, 60000)
  @ApiOperation({
    summary:
      'Edit vehicle details as admin, preserving ownership and trip safeguards',
  })
  update(
    @Request() req: AdminRequest,
    @Param('vehicleId', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateVehicleDto,
  ) {
    return this.vehicles.update(req.user.userId, id, dto);
  }

  @Put(':vehicleId/deactivate')
  @SensitiveThrottle(10, 60000)
  @ApiOperation({
    summary:
      'Deactivate a vehicle unless an ongoing, upcoming or active recurring trip uses it (no deletion)',
  })
  deactivate(
    @Request() req: AdminRequest,
    @Param('vehicleId', ParseUUIDPipe) id: string,
  ) {
    return this.vehicles.deactivate(req.user.userId, id);
  }
}
