import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { VehiclesService } from './vehicles.service';
import { CreateVehicleDto, UpdateVehicleDto } from './dto/vehicle.dto';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';

@ApiTags('Vehicles')
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Post()
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({ summary: 'Create a new vehicle' })
  async create(@Request() req, @Body() createVehicleDto: CreateVehicleDto) {
    return this.vehiclesService.create(req.user.userId, createVehicleDto);
  }

  @Get()
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get all vehicles of the current user' })
  async findAll(@Request() req) {
    return this.vehiclesService.findAllByOwner(req.user.userId);
  }

  @Get(':id')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get a vehicle by ID' })
  async findOne(@Request() req, @Param('id') id: string) {
    return this.vehiclesService.findOne(id, req.user.userId);
  }

  @Put(':id')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Update a vehicle' })
  async update(
    @Request() req,
    @Param('id') id: string,
    @Body() updateVehicleDto: UpdateVehicleDto,
  ) {
    return this.vehiclesService.update(id, req.user.userId, updateVehicleDto);
  }

  @Delete(':id')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Deactivate a vehicle (can be used even if linked to trips)' })
  async remove(@Request() req, @Param('id') id: string) {
    await this.vehiclesService.remove(id, req.user.userId);
    return { message: 'Véhicule désactivé avec succès' };
  }
}

