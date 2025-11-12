import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

export const THROTTLE_KEY = 'throttle';

export const ThrottleCustom = (limit: number, ttl: number) => {
  return applyDecorators(
    SetMetadata(THROTTLE_KEY, { limit, ttl }),
    UseGuards(ThrottlerGuard),
    Throttle({ default: { limit, ttl } }),
  );
};

