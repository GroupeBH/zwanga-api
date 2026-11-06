import {
  BadRequestException,
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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import { StorePermission } from '../store-management/store.permissions';
import { StoreService } from '../store-management/store.service';
import { MobileInstallationsService } from './mobile-installations.service';
import { MobilePoliciesService } from './mobile-policies.service';
import { MobileCampaignsService } from './mobile-campaigns.service';
import { MobileAnalyticsService } from './mobile-analytics.service';
import { MobileMaintenanceService } from './mobile-maintenance.service';
import {
  MobileCampaignDto,
  MobileCampaignEditDto,
  MobileInstallationPageDto,
  MobileLaunchDto,
  MobilePageDto,
  MobilePolicyDto,
  MobilePolicyEditDto,
  MobileResolutionDto,
  MobileRevisionDto,
} from './mobile.dto';

type Actor = {
  user: { userId: string; role: UserRole };
  storePermissions: string[];
};
@ApiTags('Admin Mobile Operations')
@ApiBearerAuth()
@Controller('admin/mobile-operations')
@Roles(UserRole.ADMIN, UserRole.MARKETER)
@SensitiveThrottle(60, 60000)
export class MobileAdminController {
  constructor(
    private readonly installations: MobileInstallationsService,
    private readonly policies: MobilePoliciesService,
    private readonly campaigns: MobileCampaignsService,
    private readonly analytics: MobileAnalyticsService,
    private readonly maintenance: MobileMaintenanceService,
    private readonly stores: StoreService,
  ) {}
  @Get('overview')
  @StorePermission('mobile.analytics.read')
  @ApiOperation({
    summary:
      'Cached supervision; local data only, explicit partial/unavailable sources',
  })
  overview(@Query() q: MobilePageDto) {
    return this.analytics.overview(q);
  }
  @Get('analytics')
  @StorePermission('mobile.analytics.read')
  @ApiOperation({
    summary:
      'Daily activity, adoption, mature retention, accounts and store metrics',
  })
  metrics(@Query() q: MobilePageDto) {
    return this.analytics.overview(q);
  }
  @Get('integrations')
  @StorePermission('store.integrations.manage')
  @ApiOperation({
    summary: 'Reuse Store Management integration status, no secret values',
  })
  integrations(@Request() req: Actor) {
    return this.stores.status(req.user.role, req.storePermissions as any);
  }
  @Get('installations')
  @StorePermission('mobile.installations.read')
  @ApiOperation({
    summary:
      'Installation inventory without push tokens, secrets or account IDs',
  })
  listInstallations(@Query() q: MobileInstallationPageDto) {
    return this.installations.list(q);
  }
  @Get('installations/:id/history')
  @StorePermission('mobile.installations.read')
  @ApiOperation({ summary: 'Minimized daily technical contact history' })
  installationHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: MobilePageDto,
  ) {
    return this.installations.history(id, q);
  }
  @Get('releases')
  @StorePermission('store.versions.read')
  @ApiOperation({ summary: 'Existing confirmed application releases' })
  releases(@Query() q: MobilePageDto) {
    return this.policies.releases(q);
  }
  @Get('releases/:id')
  @StorePermission('store.versions.read')
  @ApiOperation({ summary: 'Existing release details' })
  release(@Param('id') id: string, @Query() q: MobilePageDto) {
    if (!/^\d{1,18}$/.test(id))
      throw new BadRequestException('Release invalide.');
    return this.policies.releases(q, id);
  }
  @Get('policies')
  @StorePermission('mobile.policies.manage')
  @ApiOperation({ summary: 'Paginated version policies' })
  listPolicies(@Query() q: MobilePageDto) {
    return this.policies.list(q);
  }
  @Post('policies')
  @StorePermission('mobile.policies.manage')
  @ApiOperation({
    summary: 'Create inactive policy; explicit availability evidence required',
  })
  policy(@Request() req: Actor, @Body() dto: MobilePolicyDto) {
    return this.policies.save(req.user.userId, dto);
  }
  @Put('policies/:id')
  @StorePermission('mobile.policies.manage')
  @ApiOperation({
    summary: 'Edit by revision; disables policy pending reactivation',
  })
  editPolicy(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MobilePolicyEditDto,
  ) {
    if (id !== dto.id) throw new BadRequestException('Identifiant incohérent.');
    return this.policies.save(req.user.userId, dto, dto.revision);
  }
  @Post('policies/:id/activate')
  @StorePermission('mobile.policies.manage')
  @ApiOperation({
    summary:
      'Activate policy after checking availability and staged rollout conflicts',
  })
  activate(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MobileRevisionDto,
  ) {
    return this.policies.activate(req.user.userId, id, dto, true);
  }
  @Post('policies/:id/deactivate')
  @StorePermission('mobile.policies.manage')
  @ApiOperation({
    summary: 'Disable policy without changing application business flows',
  })
  deactivate(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MobileRevisionDto,
  ) {
    return this.policies.activate(req.user.userId, id, dto, false);
  }
  @Get('campaigns')
  @StorePermission('mobile.campaigns.read')
  @ApiOperation({ summary: 'Campaign state and scheduling' })
  listCampaigns(@Query() q: MobilePageDto) {
    return this.campaigns.list(q);
  }
  @Post('campaigns')
  @StorePermission('mobile.campaigns.create')
  @ApiOperation({ summary: 'Create draft; never sends from HTTP' })
  campaign(@Request() req: Actor, @Body() dto: MobileCampaignDto) {
    return this.campaigns.save(req.user.userId, dto);
  }
  @Put('campaigns/:id')
  @StorePermission('mobile.campaigns.create')
  @ApiOperation({
    summary: 'Edit draft/approved campaign; clears prior approval',
  })
  editCampaign(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MobileCampaignEditDto,
  ) {
    if (id !== dto.id) throw new BadRequestException('Identifiant incohérent.');
    return this.campaigns.save(req.user.userId, dto, dto.revision);
  }
  @Get('campaigns/:id/preview')
  @StorePermission('mobile.campaigns.read')
  @ApiOperation({
    summary:
      'Preview content and bounded-time audience estimate; not an immutable recipient list',
  })
  preview(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.preview(id);
  }
  @Get('campaigns/:id/stats')
  @StorePermission('mobile.campaigns.read')
  @ApiOperation({
    summary:
      'Provider acceptance, failures, instrumented opens; no invented conversion',
  })
  stats(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.stats(id);
  }
  @Post('campaigns/:id/approve')
  @StorePermission('mobile.campaigns.approve')
  @ApiOperation({
    summary: 'Second administrator approval, including for super admins',
  })
  approve(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MobileRevisionDto,
  ) {
    return this.campaigns.action(req.user.userId, id, 'approve', dto);
  }
  @Post('campaigns/:id/launch')
  @StorePermission('mobile.campaigns.launch')
  @ApiOperation({
    summary: 'Launch now or schedule; separate global send kill switch',
  })
  launch(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MobileLaunchDto,
  ) {
    return this.campaigns.action(req.user.userId, id, 'launch', dto);
  }
  @Post('campaigns/:id/cancel')
  @StorePermission('mobile.campaigns.launch')
  @ApiOperation({
    summary:
      'Cancel future attempts; already accepted provider messages cannot be recalled',
  })
  cancel(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MobileRevisionDto,
  ) {
    return this.campaigns.action(req.user.userId, id, 'cancel', dto);
  }
  @Get('audit-logs')
  @StorePermission('mobile.audit.read')
  @ApiOperation({ summary: 'Paginated sensitive operation history' })
  audit(@Query() q: MobilePageDto) {
    return this.analytics.audit(q);
  }
  @Post('alerts/:id/resolve')
  @StorePermission('store.alerts.manage')
  @ApiOperation({
    summary: 'Resolve an alert in the existing Store Management admin inbox',
  })
  resolve(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MobileResolutionDto,
  ) {
    return this.maintenance.resolve(req.user.userId, id, dto.resolution);
  }
  @Get('alerts')
  @StorePermission('store.alerts.read')
  @ApiOperation({
    summary: 'Existing admin alert inbox with explicit resolution',
  })
  alerts(@Query() q: MobilePageDto) {
    return this.maintenance.events(q);
  }
}
