import { Module, Global } from '@nestjs/common';
import { CacheService } from './services/cache.service';
import { RedisService } from './services/redis.service';
import { FileUploadService } from './services/file-upload.service';
import { S3Service } from './services/s3.service';
import { ContentModerationService } from './services/content-moderation.service';

@Global()
@Module({
  providers: [
    CacheService,
    RedisService,
    S3Service,
    ContentModerationService,
    FileUploadService,
  ],
  exports: [
    CacheService,
    RedisService,
    S3Service,
    ContentModerationService,
    FileUploadService,
  ],
})
export class CommonModule {}

