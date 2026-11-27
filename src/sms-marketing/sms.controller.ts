import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Request,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import { SmsCampaignsService } from './sms.campaigns';
import { SmsDeliveryService } from './sms.delivery';
import { SmsOptOutsService } from './sms.opt-outs';
import { SmsHttpErrors } from './sms.http-errors';
import {
  SmsCreateDto,
  SmsEstimateDto,
  SmsLaunchDto,
  SmsOptOutDto,
  SmsPageDto,
  SmsReasonDto,
  SmsRequestDto,
  SmsRevisionDto,
  SmsTestDto,
  SmsUpdateDto,
} from './sms.dto';
type Actor = { user: { userId: string } };

@Controller('admin/sms-marketing')
@UseFilters(SmsHttpErrors)
@Auth()
@Roles(UserRole.ADMIN, UserRole.MARKETER)
export class SmsMarketingController {
  constructor(
    private readonly campaigns: SmsCampaignsService,
    private readonly delivery: SmsDeliveryService,
    private readonly optOuts: SmsOptOutsService,
  ) {}
  @Get('status') status(@Request() r: Actor) {
    return this.campaigns.status(r.user.userId);
  }
  @Post('audience/estimate')
  @SensitiveThrottle(30, 60000)
  estimate(@Request() r: Actor, @Body() dto: SmsEstimateDto) {
    return this.campaigns.estimate(r.user.userId, dto);
  }
  @Get('campaigns') list(@Request() r: Actor, @Query() q: SmsPageDto) {
    return this.campaigns.list(r.user.userId, q);
  }
  @Post('campaigns') create(@Request() r: Actor, @Body() dto: SmsCreateDto) {
    return this.campaigns.create(r.user.userId, dto);
  }
  @Get('campaigns/:id') get(
    @Request() r: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.campaigns.get(r.user.userId, id);
  }
  @Put('campaigns/:id') update(
    @Request() r: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SmsUpdateDto,
  ) {
    return this.campaigns.update(r.user.userId, id, dto);
  }
  @Post('campaigns/:id/test')
  @SensitiveThrottle(5, 3600000)
  test(
    @Request() r: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SmsTestDto,
  ) {
    return this.delivery.test(r.user.userId, id, dto);
  }
  @Post('campaigns/:id/launch') launch(
    @Request() r: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SmsLaunchDto,
  ) {
    return this.campaigns.launch(r.user.userId, id, dto);
  }
  @Post('campaigns/:id/resume') resume(
    @Request() r: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SmsRevisionDto,
  ) {
    return this.campaigns.resume(r.user.userId, id, dto.revision);
  }
  @Post('campaigns/:id/cancel') cancel(
    @Request() r: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SmsRevisionDto,
  ) {
    return this.campaigns.cancel(r.user.userId, id, dto.revision);
  }
  @Post('campaigns/:id/duplicate') duplicate(
    @Request() r: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SmsRequestDto,
  ) {
    return this.campaigns.duplicate(r.user.userId, id, dto.requestId);
  }
  @Get('campaigns/:id/recipients') recipients(
    @Request() r: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: SmsPageDto,
  ) {
    return this.campaigns.recipients(r.user.userId, id, q);
  }
  @Get('opt-outs') listOptOuts(@Request() r: Actor, @Query() q: SmsPageDto) {
    return this.optOuts.list(r.user.userId, q);
  }
  @Post('opt-outs') optOut(@Request() r: Actor, @Body() dto: SmsOptOutDto) {
    return this.optOuts.add(r.user.userId, dto);
  }
  @Delete('opt-outs/:id') optIn(
    @Request() r: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SmsReasonDto,
  ) {
    return this.optOuts.remove(r.user.userId, id, dto.reason);
  }
}

@Controller('sms/s')
@UseFilters(SmsHttpErrors)
@Public()
@Throttle({
  default: {
    limit: 20,
    ttl: 60000,
    getTracker: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
    generateKey: (_context, tracker, name) =>
      createHash('sha256')
        .update(`sms-public:${name}:${tracker}`)
        .digest('hex'),
  },
})
export class SmsUnsubscribeController {
  constructor(private readonly optOuts: SmsOptOutsService) {}
  private async page(code: string, confirm: boolean, res: Response) {
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.status(200).send(await this.optOuts.publicPage(code, confirm));
  }
  @Get(':code') get(@Param('code') code: string, @Res() res: Response) {
    return this.page(code, false, res);
  }
  @Post(':code') post(@Param('code') code: string, @Res() res: Response) {
    return this.page(code, true, res);
  }
}
