import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TripRequestsService } from './trip-requests.service';
import { CreateTripRequestDto, CreateDriverOfferDto, AcceptDriverOfferDto } from './dto/trip-request.dto';
import { Auth } from '../auth/decorators/auth.decorator';
import { Public } from '../common/decorators/public.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';

@ApiTags('Trip Requests')
@Controller('trip-requests')
export class TripRequestsController {
  constructor(private readonly tripRequestsService: TripRequestsService) {}

  @Post()
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({
    summary: 'Create a trip request',
    description: 'Permet à un passager de créer une demande de trajet avec un délai pour le départ. Les drivers pourront ensuite faire des offres.',
  })
  @ApiBearerAuth()
  async create(@Request() req, @Body() createTripRequestDto: CreateTripRequestDto) {
    return this.tripRequestsService.create(req.user.userId, createTripRequestDto);
  }

  @Get()
  @Public()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'Get all pending trip requests',
    description: 'Récupère toutes les demandes de trajet en attente d\'offres',
  })
  async findAll() {
    return this.tripRequestsService.findAll();
  }

  @Get('my-requests')
  @Auth()
  @ApiOperation({
    summary: 'Get my trip requests',
    description: 'Récupère toutes les demandes de trajet créées par l\'utilisateur connecté',
  })
  @ApiBearerAuth()
  async findMyRequests(@Request() req) {
    return this.tripRequestsService.findByPassenger(req.user.userId);
  }

  @Get('my-offers')
  @Auth()
  @ApiOperation({
    summary: 'Get my driver offers',
    description: 'Récupère toutes les offres faites par le driver connecté, avec les détails des demandes de trajet associées',
  })
  @ApiBearerAuth()
  async findMyOffers(@Request() req) {
    return this.tripRequestsService.findByDriver(req.user.userId);
  }

  @Get(':id')
  @Public()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'Get a trip request by ID',
    description: 'Récupère une demande de trajet spécifique. Les drivers ne voient que leurs propres offres.',
  })
  async findOne(@Param('id') id: string, @Request() req) {
    const userId = req.user?.userId;
    return this.tripRequestsService.findOne(id, userId);
  }

  @Post(':id/offers')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({
    summary: 'Create a driver offer for a trip request',
    description: 'Permet à un driver de faire une offre pour une demande de trajet',
  })
  @ApiBearerAuth()
  async createDriverOffer(
    @Request() req,
    @Param('id') tripRequestId: string,
    @Body() createDriverOfferDto: CreateDriverOfferDto,
  ) {
    return this.tripRequestsService.createDriverOffer(req.user.userId, tripRequestId, createDriverOfferDto);
  }

  @Post(':id/accept-offer')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary: 'Accept a driver offer',
    description: 'Permet au passager de choisir et accepter une offre de driver. Toutes les autres offres seront automatiquement rejetées.',
  })
  @ApiBearerAuth()
  async acceptDriverOffer(
    @Request() req,
    @Param('id') tripRequestId: string,
    @Body() acceptDto: AcceptDriverOfferDto,
  ) {
    return this.tripRequestsService.acceptDriverOffer(req.user.userId, tripRequestId, acceptDto);
  }

  @Put(':id/start-trip')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary: 'Start a trip from an accepted trip request',
    description: 'Permet au driver sélectionné de lancer le trajet à partir d\'une demande acceptée. Crée un trajet et une réservation automatique pour le passager.',
  })
  @ApiBearerAuth()
  async startTripFromRequest(@Request() req, @Param('id') id: string) {
    return this.tripRequestsService.startTripFromRequest(id, req.user.userId);
  }

  @Delete(':id')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary: 'Cancel a trip request',
    description: 'Permet au passager d\'annuler sa demande de trajet',
  })
  @ApiBearerAuth()
  async cancel(@Request() req, @Param('id') id: string) {
    await this.tripRequestsService.cancel(req.user.userId, id);
    return { message: 'Trip request cancelled successfully' };
  }
}

