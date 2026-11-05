import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Request,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import {
  MobileInstallationDto,
  MobilePageDto,
  MobileSequenceDto,
  MobileVersionCheckDto,
} from './mobile.dto';
import { MobileInstallationsService } from './mobile-installations.service';
import { MobilePoliciesService } from './mobile-policies.service';
import { MobileCampaignsService } from './mobile-campaigns.service';

@ApiTags('Mobile Operations')
@ApiHeader({
  name: 'x-installation-secret',
  description:
    '64–128 random base64url characters stored in device secure storage; never log',
  required: false,
})
@Controller('mobile')
export class MobileController {
  constructor(
    private readonly installations: MobileInstallationsService,
    private readonly policies: MobilePoliciesService,
    private readonly campaigns: MobileCampaignsService,
  ) {}
  @Put('installations/:id')
  @Public()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({
    summary:
      'Register/update anonymous installation, token and preferences atomically; monotonic sequence',
  })
  register(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('x-installation-secret') secret: string | undefined,
    @Body() dto: MobileInstallationDto,
  ) {
    return this.installations.register(id, secret, dto);
  }
  @Post('installations/:id/link')
  @ApiBearerAuth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({
    summary:
      'Link to authenticated JWT account only; supports explicit account switching',
  })
  link(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('x-installation-secret') secret: string | undefined,
    @Request() req: { user: { userId: string } },
    @Body() dto: MobileSequenceDto,
  ) {
    return this.installations.link(id, secret, req.user.userId, dto.sequence);
  }
  @Post('installations/:id/unlink')
  @ApiBearerAuth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({
    summary:
      'Unlink before logout using current session and installation secret',
  })
  unlink(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('x-installation-secret') secret: string | undefined,
    @Request() req: { user: { userId: string } },
    @Body() dto: MobileSequenceDto,
  ) {
    return this.installations.link(
      id,
      secret,
      req.user.userId,
      dto.sequence,
      true,
    );
  }
  @Delete('installations/:id')
  @Public()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary:
      'Erase installation telemetry/tokens; retain non-reusable tombstone until retention deadline',
  })
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('x-installation-secret') secret: string | undefined,
  ) {
    return this.installations.remove(id, secret);
  }
  @Post('version/check')
  @Public()
  @SensitiveThrottle(60, 60000)
  @ApiOperation({
    summary:
      'Native build policy decision; never blocks current rides, safety, support or completion',
  })
  check(
    @Body() dto: MobileVersionCheckDto,
    @Headers('x-installation-secret') secret: string | undefined,
  ) {
    return this.policies.check(dto, secret);
  }
  @Get('installations/:id/communications')
  @Public()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Paginated eligible in-app campaign inbox' })
  messages(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('x-installation-secret') secret: string | undefined,
    @Query() q: MobilePageDto,
  ) {
    return this.campaigns.communications(id, secret, q);
  }
  @Post('installations/:id/communications/:campaignId/opened')
  @Public()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'Idempotent client-reported open; not proof of human reading',
  })
  opened(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('x-installation-secret') secret: string | undefined,
    @Param('campaignId', new ParseUUIDPipe({ version: '4' }))
    campaignId: string,
  ) {
    return this.campaigns.opened(id, secret, campaignId);
  }
}
