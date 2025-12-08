import { Module, Global } from '@nestjs/common';
import { CacheService } from './services/cache.service';
import { RedisService } from './services/redis.service';
import { FileUploadService } from './services/file-upload.service';
import { S3Service } from './services/s3.service';
import { ContentModerationService } from './services/content-moderation.service';
import { KycValidationService } from './services/kyc-validation.service';
import { RolesGuard } from './guards/roles.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LoggingInterceptor } from './interceptors/logging.interceptor';

@Global()
@Module({
  providers: [
    CacheService,
    RedisService,
    S3Service,
    ContentModerationService,
    KycValidationService,
    FileUploadService,
    RolesGuard,
    JwtAuthGuard,
    LoggingInterceptor,
  ],
  exports: [
    CacheService,
    RedisService,
    S3Service,
    ContentModerationService,
    KycValidationService,
    FileUploadService,
    RolesGuard,
    JwtAuthGuard,
    LoggingInterceptor,
  ],
})
export class CommonModule {}

