import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  ParseUUIDPipe,
  ParseIntPipe,
  Request,
  Header,
  StreamableFile,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth } from '../../auth/decorators/auth.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../entities/user.entity';
import { KycEvidenceService } from './kyc-evidence.service';

@ApiTags('Admin')
@Controller('admin/kyc/:kycId/evidence')
@Auth()
@Roles(UserRole.ADMIN)
@SensitiveThrottle(10, 60000)
export class KycEvidenceController {
  constructor(private readonly evidence: KycEvidenceService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  request(
    @Param('kycId', new ParseUUIDPipe()) kycId: string,
    @Request() req: { user: { userId: string } },
  ) {
    return this.evidence.request(kycId, req.user.userId);
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Param('kycId', new ParseUUIDPipe()) kycId: string) {
    return this.evidence.list(kycId);
  }

  @Get(':archiveId')
  @Header('Cache-Control', 'no-store')
  details(
    @Param('kycId', new ParseUUIDPipe()) kycId: string,
    @Param('archiveId', new ParseUUIDPipe()) id: string,
    @Request() req: { user: { userId: string } },
  ) {
    return this.evidence.details(kycId, id, req.user.userId);
  }
  @Delete(':archiveId')
  @Header('Cache-Control', 'no-store')
  expire(
    @Param('kycId', new ParseUUIDPipe()) kycId: string,
    @Param('archiveId', new ParseUUIDPipe()) id: string,
    @Request() req: { user: { userId: string } },
  ) {
    return this.evidence.expire(kycId, id, req.user.userId);
  }
  @Get(':archiveId/files/:index')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async file(
    @Param('kycId', new ParseUUIDPipe()) kycId: string,
    @Param('archiveId', new ParseUUIDPipe()) id: string,
    @Param('index', new ParseIntPipe()) index: number,
    @Request() req: { user: { userId: string } },
  ) {
    return new StreamableFile(
      await this.evidence.file(kycId, id, index, req.user.userId),
      {
        type: 'image/jpeg',
        disposition: `attachment; filename="kyc-${index}.jpg"`,
      },
    );
  }
}
