import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import { StoreService } from './store.service';
import {
  StoreMetricsDto,
  StorePageDto,
  StoreRangeDto,
  StoreRecordsDto,
  StoreReplyDto,
  StoreRequestDto,
  StoreSyncDto,
} from './store.dto';
import { StorePermission } from './store.permissions';
import type { StorePlatform } from './store.types';
import { StoreExportDto, StoreExportsService } from './store-exports.service';
import { spreadsheetHeaders } from '../admin/spreadsheet';

interface Actor {
  user: { userId: string; role: UserRole };
  storePermissions: string[];
}
const platforms = { google: 'google', apple: 'apple' };
@ApiTags('Admin Store Management')
@Controller(['admin/stores', 'admin/store-management'])
@Auth()
@Roles(UserRole.ADMIN, UserRole.MARKETER)
@StorePermission('store.access')
export class StoreController {
  constructor(
    private readonly stores: StoreService,
    private readonly exports: StoreExportsService,
  ) {}
  @Get('status')
  @ApiOperation({
    summary:
      'Configuration status without credentials and current Store permissions',
  })
  status(@Request() req: Actor) {
    return this.stores.status(req.user.role, req.storePermissions);
  }

  @Get([
    'dashboard',
    'overview',
    'analytics/comparison',
    'analytics/conversion',
    'analytics/acquisition',
  ])
  @StorePermission('store.analytics.read')
  @SensitiveThrottle(20, 60000)
  @ApiOperation({
    summary:
      'Consolidated local history, platform comparison and aggregate Zwanga cohorts (no attribution)',
  })
  dashboard(@Query() query: StoreRangeDto) {
    return this.stores.dashboard(query);
  }
  @Get('analytics/google')
  @StorePermission('store.analytics.read')
  google(@Query() query: StoreRangeDto) {
    return this.stores.dashboard({ ...query, platform: 'google' });
  }
  @Get('analytics/apple')
  @StorePermission('store.analytics.read')
  apple(@Query() query: StoreRangeDto) {
    return this.stores.dashboard({ ...query, platform: 'apple' });
  }
  @Get('analytics/countries')
  @StorePermission('store.analytics.read')
  countries(@Query() query: StoreMetricsDto) {
    return this.stores.countries(query);
  }
  @Get('reviews')
  @StorePermission('store.reviews.read')
  reviews(@Query() query: StoreRecordsDto) {
    return this.stores.records({ ...query, kind: 'review' });
  }
  @Get(['versions', 'review-status'])
  @StorePermission('store.versions.read')
  versions(@Query() query: StoreRecordsDto) {
    return this.stores.records({ ...query, kind: 'release' });
  }
  @Get('builds')
  @StorePermission('store.versions.read')
  builds(@Query() query: StoreRecordsDto) {
    return this.stores.records({ ...query, kind: 'build' });
  }
  @Get('vitals')
  @StorePermission('store.vitals.read')
  vitals(@Query() query: StoreRecordsDto) {
    return this.stores.records({ ...query, kind: 'performance' });
  }
  @Get('vitals/errors')
  @StorePermission('store.vitals.read')
  errors(@Query() query: StoreRecordsDto) {
    return this.stores.records({
      ...query,
      kind: 'performance',
      category: 'error_issue',
    });
  }

  @Get('records')
  @StorePermission('store.records.read')
  @ApiOperation({
    summary:
      'Imported apps, reviews, releases, TestFlight builds, reports and technical data',
  })
  records(@Query() query: StoreRecordsDto) {
    return this.stores.records(query);
  }

  @Get('metrics/catalog')
  @StorePermission('store.analytics.read')
  @ApiOperation({
    summary: 'Metric definitions, units and permitted aggregation',
  })
  catalog() {
    return this.stores.metricCatalog();
  }

  @Get('metrics')
  @StorePermission('store.analytics.read')
  @ApiOperation({
    summary:
      'Paginated historical metrics and acquisition breakdowns from PostgreSQL only',
  })
  metrics(@Query() query: StoreMetricsDto) {
    return this.stores.metrics(query);
  }

  @Get(['syncs', 'sync/history'])
  @StorePermission('store.sync.read')
  @ApiOperation({
    summary:
      'Paginated sync history and audit trail of administrator review replies',
  })
  history(@Query() query: StorePageDto) {
    return this.stores.history(query);
  }
  @Get('sync/:id')
  @StorePermission('store.sync.read')
  job(@Param('id', ParseUUIDPipe) id: string) {
    return this.stores.job(id);
  }

  @Get('alerts')
  @StorePermission('store.alerts.read')
  @ApiOperation({
    summary:
      'Technical alerts: missing/stale data, sync failures and ambiguous remote writes',
  })
  alerts() {
    return this.stores.alerts();
  }

  @Post([':platform/sync', 'sync/:platform'])
  @StorePermission('store.sync.execute')
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary:
      'Enqueue a bounded manual sync; requestId makes retries idempotent. Never publishes a release.',
  })
  sync(
    @Request() req: Actor,
    @Param('platform', new ParseEnumPipe(platforms)) platform: StorePlatform,
    @Body() body: StoreSyncDto,
  ) {
    return this.stores.sync(req.user.userId, platform, body);
  }
  @Post('syncs/:id/retry')
  @StorePermission('store.sync.execute')
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary:
      'Retry an unsuccessful read-only import (not an uncertain review reply)',
  })
  retry(
    @Request() req: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: StoreRequestDto,
  ) {
    return this.stores.retry(req.user.userId, id, body.requestId);
  }
  @Post('apple/analytics-request')
  @StorePermission('store.integrations.manage')
  @SensitiveThrottle(2, 60000)
  @ApiOperation({
    summary:
      'Explicitly request ongoing Apple analytics generation if absent (requires Apple Admin key)',
  })
  requestAnalytics(@Request() req: Actor, @Body() body: StoreRequestDto) {
    return this.stores.requestAnalytics(req.user.userId, body.requestId);
  }
  @Get('reports')
  @StorePermission('store.reports.export')
  @ApiOperation({ summary: 'Available export topics and formats' })
  reports() {
    return this.exports.catalog();
  }
  @Post('reports/export')
  @StorePermission('store.reports.export')
  @SensitiveThrottle(3, 60000)
  @ApiOperation({
    summary:
      'Bounded CSV/Excel export or PDF summary. Also requires the source-specific read permission.',
  })
  async export(
    @Request() req: Actor,
    @Body() dto: StoreExportDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.exports.export(
      req.user.userId,
      req.storePermissions,
      dto,
    );
    res.set(spreadsheetHeaders(file));
    res.set('Cache-Control', 'no-store');
    return new StreamableFile(file.buffer);
  }
}
