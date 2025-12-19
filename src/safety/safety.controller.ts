import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SafetyService } from './safety.service';
import { CreateEmergencyContactDto, UpdateEmergencyContactDto, CreateMultipleEmergencyContactsDto } from './dto/emergency-contact.dto';
import { CreateSafetyAlertDto, UpdateSafetyAlertStatusDto, UpdateLocationDto } from './dto/safety-alert.dto';
import { CreateUserReportDto, UpdateReportStatusDto } from './dto/user-report.dto';

@ApiTags('Safety')
@Controller('safety')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SafetyController {
  constructor(private readonly safetyService: SafetyService) {}

  // ==================== Emergency Contacts ====================

  @Post('emergency-contacts')
  @ApiOperation({ summary: 'Créer un contact d\'urgence' })
  @ApiResponse({ status: 201, description: 'Contact d\'urgence créé avec succès' })
  async createEmergencyContact(
    @Request() req,
    @Body() createDto: CreateEmergencyContactDto,
  ) {
    return this.safetyService.createEmergencyContact(req.user.userId, createDto);
  }

  @Post('emergency-contacts/batch')
  @ApiOperation({ summary: 'Créer plusieurs contacts d\'urgence en une seule requête (jusqu\'à 5 au total)' })
  @ApiResponse({ status: 201, description: 'Contacts d\'urgence créés avec succès' })
  async createMultipleEmergencyContacts(
    @Request() req,
    @Body() createDto: CreateMultipleEmergencyContactsDto,
  ) {
    return this.safetyService.createMultipleEmergencyContacts(req.user.userId, createDto.contacts);
  }

  @Get('emergency-contacts')
  @ApiOperation({ summary: 'Récupérer tous les contacts d\'urgence de l\'utilisateur' })
  @ApiResponse({ status: 200, description: 'Liste des contacts d\'urgence' })
  async findAllEmergencyContacts(@Request() req) {
    return this.safetyService.findAllEmergencyContacts(req.user.userId);
  }

  @Put('emergency-contacts/:id')
  @ApiOperation({ summary: 'Mettre à jour un contact d\'urgence' })
  @ApiResponse({ status: 200, description: 'Contact d\'urgence mis à jour' })
  async updateEmergencyContact(
    @Request() req,
    @Param('id') id: string,
    @Body() updateDto: UpdateEmergencyContactDto,
  ) {
    return this.safetyService.updateEmergencyContact(req.user.userId, id, updateDto);
  }

  @Delete('emergency-contacts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Supprimer un contact d\'urgence' })
  @ApiResponse({ status: 204, description: 'Contact d\'urgence supprimé' })
  async deleteEmergencyContact(@Request() req, @Param('id') id: string) {
    return this.safetyService.deleteEmergencyContact(req.user.userId, id);
  }

  // ==================== Safety Alerts ====================

  @Post('alerts')
  @ApiOperation({ summary: 'Créer une alerte de sécurité' })
  @ApiResponse({ status: 201, description: 'Alerte de sécurité créée' })
  async createSafetyAlert(@Request() req, @Body() createDto: CreateSafetyAlertDto) {
    return this.safetyService.createSafetyAlert(req.user.userId, createDto);
  }

  @Post('location/update')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mettre à jour la position et l\'état du téléphone' })
  @ApiResponse({ status: 204, description: 'Position mise à jour' })
  async updateLocation(@Request() req, @Body() updateDto: UpdateLocationDto) {
    return this.safetyService.updateLocation(req.user.userId, updateDto);
  }

  @Get('alerts')
  @ApiOperation({ summary: 'Récupérer toutes les alertes de sécurité' })
  @ApiResponse({ status: 200, description: 'Liste des alertes de sécurité' })
  async findAllSafetyAlerts(@Request() req) {
    return this.safetyService.findAllSafetyAlerts(req.user.userId);
  }

  @Get('alerts/:id')
  @ApiOperation({ summary: 'Récupérer une alerte de sécurité spécifique' })
  @ApiResponse({ status: 200, description: 'Détails de l\'alerte' })
  async findOneSafetyAlert(@Request() req, @Param('id') id: string) {
    return this.safetyService.findOneSafetyAlert(id, req.user.userId);
  }

  @Put('alerts/:id/status')
  @ApiOperation({ summary: 'Mettre à jour le statut d\'une alerte de sécurité' })
  @ApiResponse({ status: 200, description: 'Statut de l\'alerte mis à jour' })
  async updateSafetyAlertStatus(
    @Request() req,
    @Param('id') id: string,
    @Body() updateDto: UpdateSafetyAlertStatusDto,
  ) {
    return this.safetyService.updateSafetyAlertStatus(id, req.user.userId, updateDto);
  }

  // ==================== User Reports ====================

  @Post('reports')
  @ApiOperation({ summary: 'Signaler un utilisateur' })
  @ApiResponse({ status: 201, description: 'Signalement créé' })
  async createUserReport(@Request() req, @Body() createDto: CreateUserReportDto) {
    return this.safetyService.createUserReport(req.user.userId, createDto);
  }

  @Get('reports')
  @ApiOperation({ summary: 'Récupérer tous les signalements de l\'utilisateur' })
  @ApiResponse({ status: 200, description: 'Liste des signalements' })
  async findAllUserReports(@Request() req) {
    return this.safetyService.findAllUserReports(req.user.userId);
  }

  @Get('reports/:id')
  @ApiOperation({ summary: 'Récupérer un signalement spécifique' })
  @ApiResponse({ status: 200, description: 'Détails du signalement' })
  async findOneUserReport(@Request() req, @Param('id') id: string) {
    return this.safetyService.findOneUserReport(id, req.user.userId);
  }

  @Put('reports/:id/status')
  @ApiOperation({ summary: 'Mettre à jour le statut d\'un signalement (Admin uniquement)' })
  @ApiResponse({ status: 200, description: 'Statut du signalement mis à jour' })
  async updateReportStatus(
    @Request() req,
    @Param('id') id: string,
    @Body() updateDto: UpdateReportStatusDto,
  ) {
    return this.safetyService.updateReportStatus(id, req.user.userId, updateDto);
  }
}

