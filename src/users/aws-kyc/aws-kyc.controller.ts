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
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Equals, IsIn, IsUUID } from 'class-validator';
import { Auth } from '../../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { IMAGE_UPLOAD_OPTIONS } from '../../common/image-upload-policy';
import { AWS_DOCUMENT_TYPES, AWS_KYC_CONSENT } from './aws-kyc.policy';
import type { AwsDocumentType } from './aws-kyc.policy';
import { AwsKycService } from './aws-kyc.service';

export class CreateAwsKycDto {
  @IsUUID('4') requestId: string;
  @IsIn(AWS_DOCUMENT_TYPES) documentType: AwsDocumentType;
  @Equals('COD') country: string;
  @Equals(AWS_KYC_CONSENT) consentVersion: string;
}

@ApiTags('AWS KYC')
@Controller('users/kyc/aws')
@Auth()
export class AwsKycController {
  constructor(private readonly service: AwsKycService) {}
  @Get('capabilities')
  @Header('Cache-Control', 'no-store')
  @SensitiveThrottle(30, 60000)
  capabilities() {
    return this.service.capabilities();
  }
  @Get('sessions/current')
  @Header('Cache-Control', 'no-store')
  @SensitiveThrottle(30, 60000)
  current(@Request() req: { user: { userId: string } }) {
    return this.service.status(req.user.userId);
  }
  @Post('sessions')
  @Header('Cache-Control', 'no-store')
  @SensitiveThrottle(3, 60000)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'front', maxCount: 1 },
        { name: 'back', maxCount: 1 },
      ],
      {
        limits: {
          ...IMAGE_UPLOAD_OPTIONS.limits,
          files: 2,
          fields: 4,
          parts: 6,
        },
      },
    ),
  )
  create(
    @Request() req: { user: { userId: string } },
    @Body() dto: CreateAwsKycDto,
    @UploadedFiles()
    files: { front?: Express.Multer.File[]; back?: Express.Multer.File[] },
  ) {
    return this.service.create(req.user.userId, dto, files);
  }
  @Get('sessions/:id')
  @Header('Cache-Control', 'no-store')
  @SensitiveThrottle(30, 60000)
  status(
    @Request() req: { user: { userId: string } },
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.status(req.user.userId, id);
  }
  @Post('sessions/:id/liveness')
  @Header('Cache-Control', 'no-store')
  @SensitiveThrottle(3, 60000)
  start(
    @Request() req: { user: { userId: string } },
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.startLiveness(req.user.userId, id);
  }
  // Notification only: accepts no scores, photos, external session ID or decision.
  // The worker also polls AWS if the app closes before this callback.
  @Post('sessions/:id/complete')
  @Header('Cache-Control', 'no-store')
  @SensitiveThrottle(10, 60000)
  complete(
    @Request() req: { user: { userId: string } },
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.status(req.user.userId, id);
  }
}
