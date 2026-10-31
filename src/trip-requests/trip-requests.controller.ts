import { DriverChoiceQuery } from './dto/driver-choice.dto';
import { TargetMapDriverDto } from './dto/target-map-driver.dto';
import { ChangeRequestDriverDto } from './dto/change-request-driver.dto';
import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Param,
  Delete,
  Request,
  Query,
  Header,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TripRequestsService } from './trip-requests.service';
import {
  CreateTripRequestDto,
  CreateDriverOfferDto,
  AcceptDriverOfferDto,
  AcceptTripRequestDto,
  UpdateTripRequestDto,
  RecommendTripRequestPriceDto,
  TripRequestVehicleOptionsDto,
  ReleaseOverdueDriverDto,
} from './dto/trip-request.dto';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { HistoryPageQuery } from '../common/history-page';

@ApiTags('Trip Requests')
@Controller('trip-requests')
export class TripRequestsController {
  constructor(private readonly tripRequestsService: TripRequestsService) {}

  @Post()
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({
    summary: 'Create a trip request',
    description:
      'Permet à un passager de créer une demande de trajet avec un délai pour le départ. Le KYC approuvé est requis uniquement au-delà de 2 places. Les drivers pourront ensuite faire des offres.',
  })
  // @ApiBearerAuth()
  async create(
    @Request() req,
    @Body() createTripRequestDto: CreateTripRequestDto,
  ) {
    return this.tripRequestsService.create(
      req.user.userId,
      createTripRequestDto,
    );
  }

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Auth()
  @Roles(UserRole.DRIVER)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'Get available, unexpired trip requests within 5 km of the driver',
    description:
      'Conducteurs authentifiés uniquement, à 5 km maximum du départ selon leur dernière position connue. Sans position utilisable, la liste est vide. Exclut les demandes expirées même avant la mise à jour du statut. Aucun téléphone dans la liste.',
  })
  async findAll(@Request() req: { user: { userId: string } }) {
    return this.tripRequestsService.findAll(req.user.userId);
  }

  @Get('driver-choices')
  @Auth()
  @Header('Cache-Control', 'private, no-store')
  @SensitiveThrottle(30, 60000)
  async driverChoices(@Request() req: { user: { userId: string } }, @Query() query: DriverChoiceQuery) {
    return this.tripRequestsService.driverChoices(req.user.userId, query);
  }

  @Get(':id/search-map')
  @Auth()
  @Header('Cache-Control', 'private, no-store')
  @SensitiveThrottle(12, 60000)
  async searchMap(@Request() req: { user: { userId: string } }, @Param('id', ParseUUIDPipe) id: string) {
    return this.tripRequestsService.searchMap(req.user.userId, id);
  }

  @Post(':id/open-search')
  @Auth()
  @SensitiveThrottle(10, 60000)
  async openSearch(@Request() req: { user: { userId: string } }, @Param('id', ParseUUIDPipe) id: string) {
    return this.tripRequestsService.openToNearbyDrivers(req.user.userId, id);
  }

  @Post(':id/target-map-driver')
  @Auth()
  @SensitiveThrottle(3, 60000)
  async targetMapDriver(@Request() req: { user: { userId: string } }, @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TargetMapDriverDto) {
    return this.tripRequestsService.targetDriverFromMap(req.user.userId, id, dto);
  }

  @Get('my-requests')
  @Header('Cache-Control', 'private, no-store')
  @Auth()
  @ApiOperation({
    summary: 'Get my trip requests',
    description:
      "Récupère toutes les demandes de trajet créées par l'utilisateur connecté",
  })
  // @ApiBearerAuth()
  async findMyRequests(@Request() req, @Query('scope') scope?: string) {
    return this.tripRequestsService.findByPassenger(req.user.userId, scope === 'activity');
  }

  @Get('my-offers')
  @Header('Cache-Control', 'private, no-store')
  @Auth()
  @Roles(UserRole.DRIVER)
  @ApiOperation({
    summary: 'Get my driver offers',
    description:
      'Récupère toutes les offres faites par le driver connecté, avec les détails des demandes de trajet associées',
  })
  // @ApiBearerAuth()
  async findMyOffers(@Request() req) {
    return this.tripRequestsService.findByDriver(req.user.userId);
  }

  @Post('recommended-price')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({
    summary: 'Recommend a trip request price',
    description:
      'Calcule le prix recommandé pour une demande de trajet : voiture = 500 FC par kilomètre et par passager, moto = 1000 FC par kilomètre et par passager. Une forte pluie dans une zone du parcours applique un coefficient de 1.3.',
  })
  async recommendPrice(@Body() payload: RecommendTripRequestPriceDto) {
    return this.tripRequestsService.recommendPrice(payload);
  }

  @Post('vehicle-options')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({
    summary: 'List vehicle choices and their recommended prices',
    description:
      'Retourne, pour un même itinéraire, chaque type de véhicule disponible avec son tarif par kilomètre, son prix par place et son prix total. Ce endpoint doit être appelé avant la création de la demande.',
  })
  async getVehicleOptions(@Body() payload: TripRequestVehicleOptionsDto) {
    return this.tripRequestsService.getVehicleOptions(payload);
  }

  @Get('pages/available')
  @Header('Cache-Control', 'private, no-store')
  @Auth()
  @Roles(UserRole.DRIVER)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Demandes disponibles à 5 km maximum de la dernière position connue ; aucune sans position utilisable.' })
  async availablePage(@Request() req, @Query() options: HistoryPageQuery) {
    return this.tripRequestsService.findRequestPage(req.user.userId, false, options);
  }

  @Get('pages/my-requests')
  @Header('Cache-Control', 'private, no-store')
  @Auth()
  async ownPage(@Request() req, @Query() options: HistoryPageQuery) {
    return this.tripRequestsService.findRequestPage(req.user.userId, true, options);
  }

  @Get('pages/my-offers')
  @Header('Cache-Control', 'private, no-store')
  @Auth()
  @Roles(UserRole.DRIVER)
  async offersPage(@Request() req, @Query() options: HistoryPageQuery) {
    return this.tripRequestsService.findOfferPage(req.user.userId, options);
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'Get a trip request by ID',
    description:
      'Le passager consulte sa demande. Avant acceptation, seuls les conducteurs autorisés à 5 km maximum du départ peuvent la voir, avec leurs propres offres. Après acceptation, le passager et le conducteur sélectionné conservent l’accès indépendamment de la distance.',
  })
  async findOne(@Param('id') id: string, @Request() req) {
    return this.tripRequestsService.findOne(id, req.user.userId);
  }

  @Get(':id/passenger-contact')
  @Header('Cache-Control', 'private, no-store')
  @Auth()
  @Roles(UserRole.DRIVER)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Contact the passenger of an open request before accepting' })
  async getPassengerContact(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Request() req: { user: { userId: string } },
  ) {
    return this.tripRequestsService.getPassengerContact(id, req.user.userId);
  }

  @Get(':id/offers')
  @Header('Cache-Control', 'private, no-store')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'Get all offers for a trip request',
    description:
      'Récupère toutes les offres faites par les conducteurs pour une demande de trajet. Seul le passager peut voir toutes les offres.',
  })
  // @ApiBearerAuth()
  async getOffers(@Param('id') id: string, @Request() req) {
    return this.tripRequestsService.getOffersForTripRequest(
      id,
      req.user.userId,
    );
  }

  @Post(':id/offers')
  @Auth()
  @Roles(UserRole.DRIVER)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({
    summary: 'Create a driver offer for a trip request',
    description:
      'Permet à un driver de faire une offre pour une demande de trajet',
  })
  // @ApiBearerAuth()
  async createDriverOffer(
    @Request() req,
    @Param('id') tripRequestId: string,
    @Body() createDriverOfferDto: CreateDriverOfferDto,
  ) {
    return this.tripRequestsService.createDriverOffer(
      req.user.userId,
      tripRequestId,
      createDriverOfferDto,
    );
  }

  @Post(':id/accept-offer')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary: 'Accept a driver offer',
    description:
      'Permet au passager de choisir et accepter une offre de driver. Toutes les autres offres seront automatiquement rejetées.',
  })
  // @ApiBearerAuth()
  async acceptDriverOffer(
    @Request() req,
    @Param('id') tripRequestId: string,
    @Body() acceptDto: AcceptDriverOfferDto,
  ) {
    return this.tripRequestsService.acceptDriverOffer(
      req.user.userId,
      tripRequestId,
      acceptDto,
    );
  }

  @Post(':id/accept')
  @Auth()
  @Roles(UserRole.DRIVER)
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary: 'Accept a trip request directly (Uber/Bolt/Yango style)',
    description:
      "Permet à un driver d'accepter directement une demande de trajet. Le driver voit le nombre de places demandées par le passager et le prix maximum accepté. Il accepte ou refuse selon que la demande lui convient ou non. Le prix utilisé est le prix maximum accepté par le passager (ou 0 si non spécifié). Crée automatiquement un trajet et une réservation pour le passager avec le nombre de places demandées.",
  })
  // @ApiBearerAuth()
  async acceptTripRequest(
    @Request() req,
    @Param('id') id: string,
    @Body() acceptDto: AcceptTripRequestDto,
  ) {
    return this.tripRequestsService.acceptTripRequest(
      req.user.userId,
      id,
      acceptDto,
    );
  }

  @Put(':id/start-trip')
  @Auth()
  @Roles(UserRole.DRIVER)
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary: 'Start a trip from an accepted trip request',
    description:
      "Permet au driver sélectionné de lancer le trajet à partir d'une demande acceptée. Crée un trajet et une réservation automatique pour le passager.",
  })

  // @ApiBearerAuth()
  async startTripFromRequest(@Request() req, @Param('id') id: string) {
    return this.tripRequestsService.startTripFromRequest(id, req.user.userId);
  }

  @Put(':id/change-driver')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({ summary: 'Changer de conducteur en conservant la commande',
    description: 'Réservé au passager propriétaire, avant prise en charge et sans paiement engagé. Écarte l’ancien conducteur pour cette demande et relance la recherche. Renvoyer selectedDriver.id et selectedAt pour protéger les nouvelles affectations.' })
  async changeSelectedDriver(
    @Request() req: { user: { userId: string } },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeRequestDriverDto,
  ) {
    return this.tripRequestsService.changeSelectedDriver(req.user.userId, id, dto);
  }

  @Put(':id/release-driver')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary: 'Release an overdue selected driver',
    description:
      'Permet au passager, après dépassement de sa plage de prise en charge et avant embarquement, de libérer le conducteur sélectionné et de rendre la demande à nouveau visible aux autres conducteurs.',
  })
  async releaseOverdueSelectedDriver(
    @Request() req: { user: { userId: string } },
    @Param('id') id: string,
    @Body() dto: ReleaseOverdueDriverDto,
  ) {
    return this.tripRequestsService.releaseOverdueSelectedDriver(
      req.user.userId,
      id,
      dto?.searchNow ?? true,
    );
  }

  @Put(':id')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({
    summary: 'Update a trip request',
    description:
      "Permet au passager de modifier sa demande de trajet (dont l'adresse de départ et/ou d'arrivée). La modification n'est possible que si aucun driver n'a été sélectionné et qu'aucune offre n'a été acceptée.",
  })
  async update(
    @Request() req,
    @Param('id') id: string,
    @Body() updateTripRequestDto: UpdateTripRequestDto,
  ) {
    return this.tripRequestsService.update(
      req.user.userId,
      id,
      updateTripRequestDto,
    );
  }

  @Delete(':id')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary: 'Cancel a trip request',
    description:
      "Permet au passager d'annuler sa demande de trajet, même après l'acceptation par un conducteur, tant que le trajet n'a pas démarré.",
  })
  // @ApiBearerAuth()
  async cancel(@Request() req, @Param('id') id: string) {
    await this.tripRequestsService.cancel(req.user.userId, id);
    return { message: "Commande de trajet annulée avec succès." };
  }
}
