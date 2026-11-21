import { ApiTags } from '@nestjs/swagger';
import {
  Controller,
  Post,
  UseInterceptors,
  Request,
  UploadedFile,
  Get,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Auth } from '../../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { CreditEvidenceService } from './credit-evidence.service';
import { FileInterceptor } from '@nestjs/platform-express';
import type { CreditActor } from '../shared/credit.store';

@ApiTags('Financing - evidence')
@Controller('zwanga-pro')
@Auth()
@SensitiveThrottle(30, 60000)
export class CreditEvidenceController {
  constructor(private readonly evidence: CreditEvidenceService) {}

  @Post('attachments')
  @SensitiveThrottle(5, 60000)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
    }),
  )
  upload(
    @Request() req: { user: CreditActor },
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.evidence.upload(req.user, file);
  }

  @Get('attachments/:id') attachment(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.evidence.attachment(req.user, id);
  }
}
