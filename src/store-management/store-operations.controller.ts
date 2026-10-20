import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import { StoreOperationsService } from './store-operations.service';
import { StorePermission } from './store.permissions';
import {
  StoreApprovalDto,
  StoreDraftDto,
  StoreGrantDto,
  StoreIncidentDto,
  StoreIntegrationDto,
  StorePublishDto,
  StoreReviewStateDto,
  StoreRevisionDto,
  StoreAlertRuleDto,
  StoreAlertRulePatchDto,
} from './store-operations.dto';
import { StorePageDto, StoreRequestDto } from './store.dto';
import { StoreService } from './store.service';
import type { StorePlatform } from './store.types';
import { StoreAlertsService } from './store-alerts.service';

interface Actor {
  user: { userId: string; role: UserRole };
}
@ApiTags('Admin Store Management')
@Controller(['admin/stores', 'admin/store-management'])
@Auth()
@Roles(UserRole.ADMIN, UserRole.MARKETER)
@StorePermission('store.access')
export class StoreOperationsController {
  constructor(
    private readonly operations: StoreOperationsService,
    private readonly stores: StoreService,
    private readonly alerts: StoreAlertsService,
  ) {}
  @Get('integrations')
  @StorePermission('store.integrations.manage')
  @ApiOperation({
    summary: 'Integration state, capabilities, schedule and safe diagnostics',
  })
  integrations() {
    return this.operations.integrations();
  }
  @Get('integrations/:platform/status')
  @StorePermission('store.integrations.manage')
  async integration(
    @Param('platform', new ParseEnumPipe({ google: 'google', apple: 'apple' }))
    platform: StorePlatform,
  ) {
    return (await this.operations.integrations()).find(
      (i) => i.platform === platform,
    );
  }
  @Patch('integrations/:platform')
  @StorePermission('store.integrations.manage')
  @SensitiveThrottle(10, 60000)
  @ApiOperation({
    summary:
      'Enable/disable one integration or configure import cadence. No credential is accepted or returned.',
  })
  configure(
    @Request() req: Actor,
    @Param('platform', new ParseEnumPipe({ google: 'google', apple: 'apple' }))
    platform: StorePlatform,
    @Body() dto: StoreIntegrationDto,
  ) {
    return this.operations.configure(req.user.userId, platform, dto);
  }
  @Post('integrations/:platform/test')
  @StorePermission('store.integrations.manage')
  @SensitiveThrottle(3, 60000)
  @ApiOperation({ summary: 'Queue a read-only connection/capability test' })
  test(
    @Request() req: Actor,
    @Param('platform', new ParseEnumPipe({ google: 'google', apple: 'apple' }))
    platform: StorePlatform,
    @Body() dto: StoreRequestDto,
  ) {
    return this.stores.sync(req.user.userId, platform, {
      task: 'connection',
      requestId: dto.requestId,
    });
  }
  @Get('access')
  @Roles(UserRole.SUPER_ADMIN)
  @StorePermission('store.access.manage')
  @ApiOperation({
    summary:
      'Store-specific RBAC profiles assigned to existing back-office accounts',
  })
  grants(@Query() dto: StorePageDto) {
    return this.operations.grants(dto);
  }
  @Put('access/:userId')
  @Roles(UserRole.SUPER_ADMIN)
  @StorePermission('store.access.manage')
  @SensitiveThrottle(10, 60000)
  @ApiOperation({
    summary:
      'Super Admin assigns a Store profile or custom permissions; custom empty array revokes all Store access',
  })
  grant(
    @Request() req: Actor,
    @Param('userId', ParseUUIDPipe) id: string,
    @Body() dto: StoreGrantDto,
  ) {
    return this.operations.grant(req.user.userId, id, dto);
  }
  @Get('reviews/:id')
  @StorePermission('store.reviews.read')
  @ApiOperation({
    summary:
      'Review and Zwanga draft/assignment/approval state (separate from store status)',
  })
  review(@Param('id', ParseUUIDPipe) id: string) {
    return this.operations.review(id);
  }
  @Post('reviews/:id/draft')
  @StorePermission('store.reviews.draft')
  @ApiOperation({
    summary:
      'Save a draft with optimistic revision; invalidates previous approval',
  })
  draft(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StoreDraftDto,
  ) {
    return this.operations.draft(req.user.userId, id, dto);
  }
  @Post('reviews/:id/submit')
  @StorePermission('store.reviews.draft')
  @ApiOperation({ summary: 'Submit an existing draft for approval' })
  submit(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StoreRevisionDto,
  ) {
    return this.operations.submit(req.user.userId, id, dto.revision);
  }
  @Post('reviews/:id/approve')
  @StorePermission('store.reviews.approve')
  @ApiOperation({
    summary:
      'Approve a submitted draft. Self-approval requires Super Admin and an audited reason.',
  })
  approve(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StoreApprovalDto,
  ) {
    return this.operations.approve(req.user.userId, req.user.role, id, dto);
  }
  @Post(['reviews/:id/publish', 'reviews/:id/reply'])
  @StorePermission('store.reviews.reply')
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary:
      'Queue PUBLIC reply using the approved revision, never arbitrary unapproved text',
  })
  publish(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StorePublishDto,
  ) {
    return this.operations.publish(req.user.userId, id, dto);
  }
  @Post('reviews/:id/reconcile')
  @StorePermission('store.reviews.reply')
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary:
      'Resolve an uncertain reply only after a newer import observes exactly the approved response; no external write',
  })
  reconcile(@Request() req: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.operations.reconcileReply(req.user.userId, id);
  }
  @Patch('reviews/:id/status')
  @StorePermission('store.reviews.draft')
  @ApiOperation({
    summary: 'Assign, mark in progress or close a review internally',
  })
  state(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StoreReviewStateDto,
  ) {
    return this.operations.reviewState(req.user.userId, id, dto);
  }
  @Get('audit-logs')
  @StorePermission('store.audit.read')
  @ApiOperation({
    summary: 'Paginated administrator actions and publication/approval audit',
  })
  audit(@Query() query: StorePageDto) {
    return this.operations.audit(query);
  }
  @Get('versions/:id/incidents')
  @StorePermission('store.versions.read')
  @ApiOperation({
    summary:
      'Internal submission/refusal notes, not an official provider decision',
  })
  incidents(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: StorePageDto,
  ) {
    return this.operations.incidents(id, query);
  }
  @Post('versions/:id/incidents')
  @StorePermission('store.integrations.manage')
  @ApiOperation({
    summary:
      'Record a manual rejection reason, responsible person and technical task reference',
  })
  incident(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StoreIncidentDto,
  ) {
    return this.operations.incident(req.user.userId, id, dto);
  }
  @Post('incidents/:id/resolve')
  @StorePermission('store.integrations.manage')
  @ApiOperation({ summary: 'Resolve an internal submission incident' })
  resolve(@Request() req: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.operations.resolveIncident(req.user.userId, id);
  }
  @Get('alerts/rules')
  @StorePermission('store.alerts.manage')
  @ApiOperation({ summary: 'Alert rules and recipients (maximum 100 rules)' })
  rules() {
    return this.operations.rules();
  }
  @Post('alerts/rules')
  @StorePermission('store.alerts.manage')
  @ApiOperation({
    summary:
      'Create a threshold/event alert rule for existing back-office recipients',
  })
  createRule(@Request() req: Actor, @Body() dto: StoreAlertRuleDto) {
    return this.operations.rule(req.user.userId, null, dto);
  }
  @Put('alerts/rules/:id')
  @StorePermission('store.alerts.manage')
  @ApiOperation({
    summary: 'Replace an alert rule configuration, including activation',
  })
  updateRule(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StoreAlertRuleDto,
  ) {
    return this.operations.rule(req.user.userId, id, dto);
  }
  @Patch('alerts/rules/:id')
  @StorePermission('store.alerts.manage')
  @ApiOperation({
    summary: 'Partially update an alert rule without losing its other settings',
  })
  patchRule(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StoreAlertRulePatchDto,
  ) {
    return this.operations.patchRule(req.user.userId, id, dto);
  }
  @Get('alerts/events')
  @StorePermission('store.alerts.read')
  @ApiOperation({
    summary: 'Persisted Admin notifications and email delivery state',
  })
  events(@Query() dto: StorePageDto) {
    return this.alerts.events(dto);
  }
  @Post('alerts/events/:id/acknowledge')
  @StorePermission('store.alerts.read')
  acknowledge(@Request() req: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.alerts.acknowledge(req.user.userId, id);
  }
}
