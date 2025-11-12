import { Module, Global } from '@nestjs/common';
import { CacheService } from './services/cache.service';
import { RedisService } from './services/redis.service';

@Global()
@Module({
  providers: [CacheService, RedisService],
  exports: [CacheService, RedisService],
})
export class CommonModule {}

