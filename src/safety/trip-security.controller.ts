import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import {
  CancelTripSecurityDto,
  ConfirmTripSecurityDto,
  ManualEscalationDto,
  NotifyTrustedContactsDto,
  StartTripSecurityTrackingDto,
  UpdateTripSecurityConfigurationDto,
} from './dto/trip-security.dto';
import { TripSecurityService } from './trip-security.service';

@ApiTags('Safety Trip Security')
@Controller('safety/trip-security')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class TripSecurityController {
  constructor(private readonly tripSecurityService: TripSecurityService) {}

  @Post('start')
  @ApiOperation({
    summary:
      'Démarrer le suivi sécurité individuel d’un conducteur ou d’un passager (embarquement)',
  })
  @ApiResponse({ status: 201, description: 'Suivi sécurité démarré' })
  async startTracking(@Request() req, @Body() dto: StartTripSecurityTrackingDto) {
    return this.tripSecurityService.startTracking(req.user.userId, dto);
  }

  @Post(':participantId/notify-trusted-contacts')
  @ApiOperation({
    summary: 'Notifier les proches de confiance pour un participant suivi',
  })
  @ApiResponse({ status: 200, description: 'Notifications envoyées' })
  async notifyTrustedContacts(
    @Request() req,
    @Param('participantId') participantId: string,
    @Body() dto: NotifyTrustedContactsDto,
  ) {
    return this.tripSecurityService.notifyTrustedContacts(participantId, req.user.userId, dto);
  }

  @Post(':participantId/confirm')
  @ApiOperation({
    summary: 'Confirmer explicitement l’arrivée / dépôt / fin de trajet pour un participant',
  })
  @ApiResponse({ status: 200, description: 'Confirmation enregistrée' })
  async confirmParticipant(
    @Request() req,
    @Param('participantId') participantId: string,
    @Body() dto: ConfirmTripSecurityDto,
  ) {
    return this.tripSecurityService.confirmParticipant(participantId, req.user.userId, dto);
  }

  @Put(':participantId/configuration')
  @ApiOperation({
    summary: 'Mettre à jour les paramètres de relance/escalade et canaux d’un participant',
  })
  @ApiResponse({ status: 200, description: 'Configuration mise à jour' })
  async updateConfiguration(
    @Request() req,
    @Param('participantId') participantId: string,
    @Body() dto: UpdateTripSecurityConfigurationDto,
  ) {
    return this.tripSecurityService.updateParticipantConfiguration(
      participantId,
      req.user.userId,
      dto,
    );
  }

  @Post(':participantId/escalate')
  @ApiOperation({
    summary: 'Déclencher manuellement une escalade vers les proches',
  })
  @ApiResponse({ status: 200, description: 'Escalade déclenchée' })
  async escalate(
    @Request() req,
    @Param('participantId') participantId: string,
    @Body() dto: ManualEscalationDto,
  ) {
    return this.tripSecurityService.escalateParticipant(participantId, req.user.userId, dto);
  }

  @Post(':participantId/cancel')
  @ApiOperation({
    summary: 'Annuler le suivi sécurité d’un participant',
  })
  @ApiResponse({ status: 200, description: 'Suivi annulé' })
  async cancel(
    @Request() req,
    @Param('participantId') participantId: string,
    @Body() dto: CancelTripSecurityDto,
  ) {
    return this.tripSecurityService.cancelTracking(participantId, req.user.userId, dto);
  }

  @Get('participants/:participantId')
  @ApiOperation({
    summary: 'Consulter le statut sécurité d’un participant',
  })
  @ApiResponse({ status: 200, description: 'Statut participant' })
  async getParticipant(@Request() req, @Param('participantId') participantId: string) {
    return this.tripSecurityService.getParticipant(participantId, req.user.userId);
  }

  @Get('participants/:participantId/history')
  @ApiOperation({
    summary: 'Consulter l’historique de sécurité d’un participant',
  })
  @ApiResponse({ status: 200, description: 'Historique participant' })
  async getParticipantHistory(@Request() req, @Param('participantId') participantId: string) {
    return this.tripSecurityService.getParticipantHistory(participantId, req.user.userId);
  }

  @Get('trips/:tripId')
  @ApiOperation({
    summary: 'Consulter les statuts sécurité de tous les participants d’un trajet',
  })
  @ApiResponse({ status: 200, description: 'Statuts sécurité du trajet' })
  async getTripParticipants(@Request() req, @Param('tripId') tripId: string) {
    return this.tripSecurityService.getTripParticipants(tripId, req.user.userId);
  }

  @Get('trips/:tripId/history')
  @ApiOperation({
    summary: 'Consulter l’historique de sécurité d’un trajet',
  })
  @ApiResponse({ status: 200, description: 'Historique sécurité du trajet' })
  async getTripHistory(@Request() req, @Param('tripId') tripId: string) {
    return this.tripSecurityService.getTripHistory(tripId, req.user.userId);
  }

  @Post('jobs/process')
  @ApiOperation({
    summary:
      'Exécuter manuellement le traitement automatique relance/escalade (outil opérateur/test)',
  })
  @ApiResponse({ status: 200, description: 'Traitement automatique exécuté' })
  async processJobs() {
    return this.tripSecurityService.processAutomaticFollowUps();
  }
}
