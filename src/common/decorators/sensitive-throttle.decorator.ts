import { applyDecorators } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

export const SensitiveThrottle = (limit = 10, ttl = 60_000) =>
  applyDecorators(Throttle({ default: { limit, ttl } }));

