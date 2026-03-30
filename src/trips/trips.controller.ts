import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Request,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TripsService } from './trips.service';
import {
  CreateTripDto,
  CreateRecurringTripDto,
  SearchTripsDto,
  UpdateTripDto,
  SearchByPointsDto,
  DriverEmergencyContactsDto,
} from './dto/trip.dto';
import { Auth } from '../auth/decorators/auth.decorator';
import { Public } from '../common/decorators/public.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';

@ApiTags('Trips')
@Controller('trips')
export class TripsController {
  constructor(private readonly tripsService: TripsService) { }

  @Post()
  @Auth()
  @SensitiveThrottle(10, 6000) // 10 requests per minute per IP
  @ApiOperation({
    summary: 'Create a new trip',
    description: 'Permet à un utilisateur de créer un trajet. Si l\'utilisateur est un passager et fournit un véhicule, il sera automatiquement promu en conducteur.'
  })
  async create(@Request() req, @Body() createTripDto: CreateTripDto) {
    return this.tripsService.create(req.user.userId, createTripDto);
  }

  @Get()
  @Public()
  @SensitiveThrottle(30, 6000) // 30 requests per minute per IP
  @ApiOperation({
    summary: 'Rechercher des trajets ou obtenir tous les trajets disponibles',
    description: 'Recherche flexible par coordonnées : vous pouvez fournir uniquement departureCoordinates, uniquement arrivalCoordinates, ou les deux. Le rayon de recherche (departureRadiusKm, arrivalRadiusKm) est optionnel pour chaque point (défaut: 50 km). Si aucun critère n\'est fourni, retourne tous les trajets disponibles.'
  })
  async findAll(@Query() searchTripsDto: SearchTripsDto) {
    if (Object.keys(searchTripsDto).length > 0) {
      return this.tripsService.search(searchTripsDto);
    }
    return this.tripsService.findAll();
  }

  @Post('search/coordinates')
  @Public()
  @SensitiveThrottle(30, 6000)
  @ApiOperation({
    summary: 'Rechercher des trajets par coordonnées',
    description: 'Recherche flexible : vous pouvez fournir uniquement departureCoordinates, uniquement arrivalCoordinates, ou les deux. Le rayon de recherche est optionnel pour chaque point (défaut: 50 km).'
  })
  async searchByCoordinates(@Body() payload: SearchByPointsDto) {
    // Validate that at least one coordinate is provided
    if (!payload.departureCoordinates && !payload.arrivalCoordinates) {
      throw new BadRequestException('Au moins un point (départ ou arrivée) doit être fourni pour la recherche');
    }

    const {
      keywords,
      departureCoordinates,
      arrivalCoordinates,
      departureRadiusKm,
      arrivalRadiusKm,
      departureDate,
      minSeats,
      maxPrice,
    } = payload;

    return this.tripsService.search({
      keywords,
      departureCoordinates,
      arrivalCoordinates,
      departureRadiusKm,
      arrivalRadiusKm,
      departureDate,
      minSeats,
      maxPrice,
    });
  }

  @Get('my-trips')
  @Auth()
  @SensitiveThrottle(20, 6000)
  @ApiOperation({ summary: 'Get trips created by current user' })
  async findMyTrips(@Request() req) {
    return this.tripsService.findByDriver(req.user.userId);
  }

  @Post('recurring')
  @Auth()
  @SensitiveThrottle(10, 6000)
  @ApiOperation({
    summary: 'Create a recurring trip template',
    description:
      'Permet a un conducteur de creer un schema recurrent et de generer automatiquement les prochaines occurrences.',
  })
  async createRecurring(@Request() req, @Body() createRecurringTripDto: CreateRecurringTripDto) {
    return this.tripsService.createRecurring(req.user.userId, createRecurringTripDto);
  }

  @Get('recurring/my')
  @Auth()
  @SensitiveThrottle(20, 6000)
  @ApiOperation({ summary: 'Get recurring trip templates created by current user' })
  async findMyRecurringTrips(@Request() req) {
    return this.tripsService.findRecurringByDriver(req.user.userId);
  }

  @Put('recurring/:id/pause')
  @Auth()
  @SensitiveThrottle(10, 6000)
  @ApiOperation({ summary: 'Pause a recurring trip template' })
  async pauseRecurringTrip(@Request() req, @Param('id') id: string) {
    return this.tripsService.pauseRecurring(id, req.user.userId);
  }

  @Put('recurring/:id/resume')
  @Auth()
  @SensitiveThrottle(10, 6000)
  @ApiOperation({ summary: 'Resume a recurring trip template' })
  async resumeRecurringTrip(@Request() req, @Param('id') id: string) {
    return this.tripsService.resumeRecurring(id, req.user.userId);
  }

  @Get('all-trips')
  @SensitiveThrottle(20, 6000)
  @ApiOperation({ summary: 'Get all trips completed or not' })
  async findAllTrips() {
    return this.tripsService.findAllTrips();
  }


  @Get(':id')
  @SensitiveThrottle(30, 6000)
  @ApiOperation({ summary: 'Get a trip by ID' })
  async findOne(@Param('id') id: string) {
    return this.tripsService.findOne(id);
  }

  @Put(':id')
  @Auth()
  @SensitiveThrottle(10, 6000)
  @ApiOperation({ summary: 'Update a trip' })
  async update(
    @Request() req,
    @Param('id') id: string,
    @Body() updateTripDto: UpdateTripDto,
  ) {
    return this.tripsService.update(id, req.user.userId, updateTripDto);
  }

  @Put(':id/start')
  @Auth()
  @SensitiveThrottle(10, 6000)
  @ApiOperation({ summary: 'Start a trip' })
  async startTrip(@Request() req, @Param('id') id: string) {
    return this.tripsService.startTrip(id, req.user.userId);
  }

  @Put(':id/driver-emergency-contacts')
  @Auth()
  @SensitiveThrottle(10, 6000)
  @ApiOperation({ summary: "Select driver's emergency contacts for trip WhatsApp safety notifications" })
  async setDriverEmergencyContacts(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: DriverEmergencyContactsDto,
  ) {
    return this.tripsService.setDriverEmergencyContacts(id, req.user.userId, dto);
  }

  @Put(':id/pause')
  @Auth()
  @SensitiveThrottle(10, 6000)
  @ApiOperation({ summary: 'Pause/interrupt an active trip' })
  async pauseTrip(@Request() req, @Param('id') id: string) {
    return this.tripsService.pauseTrip(id, req.user.userId);
  }

  @Put(':id/complete')
  @Auth()
  @SensitiveThrottle(10, 6000)
  @ApiOperation({ summary: 'Complete/end an active trip (driver only)' })
  async completeTrip(@Request() req, @Param('id') id: string) {
    return this.tripsService.completeTrip(id, req.user.userId);
  }

  @Put(':id/make-public')
  @Auth()
  @SensitiveThrottle(10, 6000)
  @ApiOperation({
    summary: 'Make a private trip public',
    description: 'Permet au passager qui a créé la demande de trajet d\'autoriser que le trajet devienne public. Le conducteur du trajet doit avoir passé le KYC et avoir au moins un véhicule actif pour que le trajet soit effectivement publié.'
  })
  async makeTripPublic(@Request() req, @Param('id') id: string) {
    return this.tripsService.makeTripPublic(id, req.user.userId);
  }

  @Delete(':id')
  @Auth()
  @SensitiveThrottle(10, 6000)
  @ApiOperation({ summary: 'Delete a trip (only completed, cancelled, or expired trips can be deleted)' })
  async remove(@Request() req, @Param('id') id: string) {
    await this.tripsService.remove(id, req.user.userId);
    return { message: 'Trajet supprimé avec succès' };
  }
}

