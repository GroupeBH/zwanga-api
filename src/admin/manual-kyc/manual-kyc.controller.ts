import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Auth } from '../../auth/decorators/auth.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../../users/entities/user.entity';
import { MANUAL_KYC_SCHEMA } from './manual-kyc.schema';
import {
  MANUAL_UPLOADS,
  ManualKycService,
  type ManualUploads,
} from './manual-kyc.service';

@Controller('admin')
@Auth()
@Roles(UserRole.ADMIN)
@SensitiveThrottle(10, 60000)
export class ManualKycController {
  constructor(private readonly manual: ManualKycService) {}
  @Get('manual-kyc/schema')
  schema() {
    return { groups: MANUAL_KYC_SCHEMA };
  }
  @Get('users/:userId/manual-kyc')
  @Header('Cache-Control', 'no-store')
  read(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Request() req: { user: { userId: string } },
  ) {
    return this.manual.read(userId, req.user.userId);
  }
  @Post('users/:userId/manual-kyc')
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(
    FileFieldsInterceptor(
      MANUAL_UPLOADS.map((name) => ({ name, maxCount: 1 })),
      {
        storage: memoryStorage(),
        limits: {
          files: 4,
          fileSize: 5 * 1024 * 1024,
          fields: 1,
          fieldSize: 64 * 1024,
          parts: 5,
        },
      },
    ),
  )
  save(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Request() req: { user: { userId: string } },
    @Body('payload') payload: string,
    @UploadedFiles() files: ManualUploads,
  ) {
    return this.manual.save(userId, req.user.userId, payload, files);
  }
}
