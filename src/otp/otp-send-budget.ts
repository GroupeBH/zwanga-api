import { HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { RedisService } from '../common/services/redis.service';

// Check all budgets before charging any. Shared by purposes/routes/replicas;
// a timeout may already have sent a paid SMS, so reservations are not refunded.
export const OTP_SEND_BUDGET_SCRIPT = `
  local cooldown = redis.call('PTTL', KEYS[1])
  if cooldown > 0 then return cooldown end
  for i = 2, 4 do
    if tonumber(redis.call('GET', KEYS[i]) or '0') >= tonumber(ARGV[i]) then
      return math.max(redis.call('PTTL', KEYS[i]), 1000)
    end
  end
  redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
  for i = 2, 4 do
    local count = redis.call('INCR', KEYS[i])
    if count == 1 then redis.call('PEXPIRE', KEYS[i], i == 2 and 3600000 or 86400000) end
  end
  return 0`;

export async function reserveOtpSend(redis: RedisService, config: ConfigService, normalizedPhone: string): Promise<void> {
  const integer = (key: string, fallback: number, max: number) => {
    const value = Number(config.get(key) ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new ServiceUnavailableException('Configuration des limites OTP invalide.');
    return value;
  };
  const limits = [integer('OTP_SEND_COOLDOWN_SECONDS', 30, 300) * 1000,
    integer('OTP_SEND_PHONE_HOURLY_LIMIT', 5, 100), integer('OTP_SEND_PHONE_DAILY_LIMIT', 10, 500),
    integer('OTP_SEND_GLOBAL_DAILY_LIMIT', 10000, 1000000)];
  const hash = createHash('sha256').update(normalizedPhone).digest('hex');
  let waitMs: number;
  try {
    waitMs = Number(await redis.getClient().eval(OTP_SEND_BUDGET_SCRIPT, {
      // Shared hash tag also makes the atomic operation valid in Redis Cluster.
      keys: [`otp:{send-budget}:cooldown:${hash}`, `otp:{send-budget}:hour:${hash}`,
        `otp:{send-budget}:day:${hash}`, 'otp:{send-budget}:global-day'],
      arguments: limits.map(String),
    }));
    if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('INVALID_BUDGET_RESULT');
  } catch {
    throw new ServiceUnavailableException('Envoi OTP momentanément indisponible. Réessayez dans un instant.');
  }
  if (waitMs > 0) throw new HttpException({ code: 'OTP_SEND_LIMIT_REACHED',
    message: `Veuillez patienter ${Math.ceil(waitMs / 1000)} secondes avant de demander un nouveau code.`,
    retryAfterSeconds: Math.ceil(waitMs / 1000) }, HttpStatus.TOO_MANY_REQUESTS);
}
