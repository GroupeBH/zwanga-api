import {
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
import { Auth } from '../auth/decorators/auth.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import {
  AcceptServiceQuoteDto,
  CaseStatusDto,
  CreateServiceCaseDto,
  CustodyDto,
  LinkServiceOwnerDto,
  ListServiceCasesDto,
  OfferingUpdateDto,
  QuoteServiceDto,
  ServiceLedgerDto,
} from './pro-service.dto';
import { ProServiceStore } from './pro-service.store';
import { ProServiceWorkflow } from './pro-service.workflow';
import { ProServiceFinance } from './pro-service.finance';
import { ProServiceConfiguration } from './pro-service.configuration';

@Controller('pro-services')
@SensitiveThrottle(30, 60000)
export class ProServicesController {
  constructor(
    private readonly store: ProServiceStore,
    private readonly workflow: ProServiceWorkflow,
    private readonly finance: ProServiceFinance,
    private readonly configuration: ProServiceConfiguration,
  ) {}
  @Get('catalogue')
  @Public()
  catalogue() {
    return this.store.catalogue();
  }
  @Post('public-applications')
  @Public()
  @SensitiveThrottle(3, 60000)
  publicApplication(@Body() dto: CreateServiceCaseDto) {
    return this.store.create(dto, null);
  }
  @Post('applications')
  @Auth()
  @SensitiveThrottle(5, 60000)
  create(@Request() req, @Body() dto: CreateServiceCaseDto) {
    return this.store.create(dto, req.user.userId);
  }
  @Get('mine')
  @Auth()
  mine(@Request() req, @Query() query: ListServiceCasesDto) {
    return this.store.list(query, req.user.userId);
  }
  @Get('mine/:id')
  @Auth()
  detail(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.store.detail(id, req.user.userId);
  }
  @Post('mine/:id/accept')
  @Auth()
  @SensitiveThrottle(5, 60000)
  accept(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptServiceQuoteDto,
  ) {
    return this.workflow.accept(id, req.user.userId, dto);
  }
  @Post('mine/:id/cancel')
  @Auth()
  @SensitiveThrottle(5, 60000)
  cancel(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflow.status(
      id,
      req.user.userId,
      { status: 'cancelled', message: 'Annulée par le demandeur.' },
      true,
    );
  }
  @Get('admin/catalogue')
  @Auth()
  @Roles(UserRole.ADMIN)
  adminCatalogue() {
    return this.store.catalogue(true);
  }
  @Put('admin/catalogue/:code')
  @Auth()
  @Roles(UserRole.SUPER_ADMIN)
  configure(
    @Request() req,
    @Param('code') code: string,
    @Body() dto: OfferingUpdateDto,
  ) {
    return this.configuration.update(code, req.user.userId, dto);
  }
  @Get('admin/cases')
  @Auth()
  @Roles(UserRole.ADMIN)
  list(@Query() query: ListServiceCasesDto) {
    return this.store.list(query);
  }
  @Get('admin/cases/:id')
  @Auth()
  @Roles(UserRole.ADMIN)
  adminDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.store.detail(id);
  }
  @Post('admin/cases/:id/quote')
  @Auth()
  @Roles(UserRole.ADMIN)
  quote(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QuoteServiceDto,
  ) {
    return this.workflow.quote(id, req.user.userId, dto);
  }
  @Put('admin/cases/:id/status')
  @Auth()
  @Roles(UserRole.ADMIN)
  status(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CaseStatusDto,
  ) {
    return this.workflow.status(id, req.user.userId, dto);
  }
  @Post('admin/cases/:id/owner')
  @Auth()
  @Roles(UserRole.ADMIN)
  owner(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkServiceOwnerDto,
  ) {
    return this.workflow.linkOwner(id, req.user.userId, dto);
  }
  @Post('admin/cases/:id/ledger')
  @Auth()
  @Roles(UserRole.ADMIN)
  ledger(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ServiceLedgerDto,
  ) {
    return this.finance.record(id, req.user.userId, dto);
  }
  @Post('admin/cases/:id/documents/:documentId')
  @Auth()
  @Roles(UserRole.ADMIN)
  document(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: CustodyDto,
  ) {
    return this.finance.custody(id, documentId, req.user.userId, dto);
  }
}
