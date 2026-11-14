import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
} from '@nestjs/common';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import {
  ActivateAssetCreditDto,
  AssetConsentDto,
  OfferAssetCreditDto,
  RepayAssetCreditDto,
  RequestAssetCreditDto,
} from './asset-credit.dto';
import { AssetCreditService } from './asset-credit.service';

@Controller(['asset-credits', 'partners/asset-credits'])
@Auth()
@SensitiveThrottle(30, 60000)
export class AssetCreditController {
  constructor(private readonly credits: AssetCreditService) {}
  @Get('access') access(@Request() req) {
    return {
      canRead: [UserRole.ADMIN, UserRole.SUPER_ADMIN].includes(req.user.role),
      canManage: req.user.role === UserRole.SUPER_ADMIN,
    };
  }
  @Get('requests') requests(@Request() req) {
    return this.credits.requests(req.user.userId);
  }
  @Post('requests')
  @SensitiveThrottle(5, 60000)
  request(@Request() req, @Body() dto: RequestAssetCreditDto) {
    return this.credits.request(req.user.userId, dto.notes);
  }
  @Get('admin-requests') @Roles(UserRole.ADMIN) allRequests() {
    return this.credits.requests();
  }
  @Get('mine') mine(@Request() req) {
    return this.credits.list(req.user.userId);
  }
  @Get('mine/:id') detail(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.credits.detail(id, req.user.userId);
  }
  @Post('mine/:id/accept') accept(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _dto: AssetConsentDto,
  ) {
    return this.credits.decide(id, req.user.userId, true);
  }
  @Post('mine/:id/decline') decline(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.credits.decide(id, req.user.userId, false);
  }
  @Post('mine/:id/repay')
  @SensitiveThrottle(5, 60000)
  repay(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RepayAssetCreditDto,
  ) {
    return this.credits.repay(id, req.user.userId, dto);
  }
  @Get('admin') @Roles(UserRole.ADMIN) all() {
    return this.credits.list();
  }
  @Get('admin/:id') @Roles(UserRole.ADMIN) adminDetail(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.credits.detail(id);
  }
  @Post('admin') @Roles(UserRole.SUPER_ADMIN) offer(
    @Request() req,
    @Body() dto: OfferAssetCreditDto,
  ) {
    return this.credits.offer(req.user.userId, dto);
  }
  @Post('admin/:id/activate')
  @Roles(UserRole.SUPER_ADMIN)
  activate(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActivateAssetCreditDto,
  ) {
    return this.credits.activate(id, req.user.userId, dto);
  }
}
