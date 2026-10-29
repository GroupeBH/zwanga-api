import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
} from 'crypto';
import { RedisService } from '../common/services/redis.service';
import { MobishastraSmsService } from './mobishastra-sms.service';
import {
  MobishastraChallenge,
  SendOtpResponse,
  VerifyOtpResponse,
} from './otp.types';

export const MOBISHASTRA_OTP_TTL_SECONDS = 15 * 60;

// Each transition is atomic and keeps the original expiry. A stale worker must
// not validate, activate or delete a challenge replaced by a resend.
export const MOBISHASTRA_CHALLENGE_SCRIPT = `
  local raw = redis.call('GET', KEYS[1])
  local ttl = redis.call('PTTL', KEYS[1])
  if not raw or ttl <= 0 then return 0 end
  local item = cjson.decode(raw)
  if item.provider ~= 'mobishastra' then return 0 end
  if ARGV[1] == 'consume-proof' then
    if item.state ~= 'verified' or item.proofHash ~= ARGV[2] then return 0 end
    redis.call('DEL', KEYS[1])
    return 1
  end
  if item.requestId ~= ARGV[2] then return 0 end
  if ARGV[1] == 'ready' then
    if item.state ~= 'pending' then return 0 end
    item.state = 'sent'
  elseif ARGV[1] == 'verify' then
    if item.state ~= 'sent' or item.attemptsRemaining <= 0 then return 0 end
    if item.codeHash ~= ARGV[3] then
      item.attemptsRemaining = item.attemptsRemaining - 1
      if item.attemptsRemaining <= 0 then redis.call('DEL', KEYS[1])
      else redis.call('SET', KEYS[1], cjson.encode(item), 'PX', ttl) end
      return 0
    end
    item.state = 'verified'
    item.codeHash = nil
    item.proofHash = ARGV[4]
  else return 0 end
  redis.call('SET', KEYS[1], cjson.encode(item), 'PX', ttl)
  return ttl
`;

@Injectable()
export class MobishastraOtpService {
  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly sms: MobishastraSmsService,
  ) {}

  assertConfigured(): void {
    this.secret();
    this.sms.assertConfigured();
  }

  private secret(): string {
    const secret = this.config.get<string>('OTP_CODE_HMAC_SECRET') || '';
    if (Buffer.byteLength(secret) < 32) {
      throw new ServiceUnavailableException(
        'Configuration OTP momentanément indisponible.',
      );
    }
    return secret;
  }

  private digest(phone: string, requestId: string, code: string): string {
    return createHmac('sha256', this.secret())
      .update(JSON.stringify(['phone_verification', phone, requestId, code]))
      .digest('hex');
  }

  private proofHash(phone: string, token: string): string {
    return createHash('sha256')
      .update(JSON.stringify([phone, token]))
      .digest('hex');
  }

  /** Called under OtpService's per-phone distributed lock and send budget. */
  async send(phone: string, key: string): Promise<SendOtpResponse> {
    const code = String(randomInt(10000, 100000));
    const challenge: MobishastraChallenge = {
      provider: 'mobishastra',
      requestId: randomUUID(),
      state: 'pending',
      codeHash: '',
      attemptsRemaining: 5,
    };
    challenge.codeHash = this.digest(phone, challenge.requestId, code);
    try {
      // If Redis fails, do not incur a paid SMS. Pending codes cannot verify.
      await this.redis.set(key, challenge, MOBISHASTRA_OTP_TTL_SECONDS);
      await this.sms.sendCode(phone, code);
      const ttl = Number(
        await this.redis.getClient().eval(MOBISHASTRA_CHALLENGE_SCRIPT, {
          keys: [key],
          arguments: ['ready', challenge.requestId],
        }),
      );
      if (!(ttl > 0)) throw new Error('CHALLENGE_EXPIRED');
      return {
        success: true,
        status: 'SENT',
        message: 'Code de vérification envoyé par SMS.',
        codeLength: 5,
        expiresInSeconds: Math.floor(ttl / 1000),
      };
    } catch {
      // Only remove our pending challenge, never a concurrent replacement.
      // On an ambiguous Redis timeout it may already be ready: fail closed at
      // the HTTP boundary; the next allowed resend replaces it in any case.
      await this.redis.consumeIfValueMatches(key, challenge).catch(() => false);
      throw new ServiceUnavailableException({
        code: 'OTP_SMS_UNAVAILABLE',
        message:
          'Le code n’a pas pu être envoyé. Réessayez dans quelques instants.',
      });
    }
  }

  async verify(
    phone: string,
    code: string,
    key: string,
    challenge: MobishastraChallenge,
  ): Promise<VerifyOtpResponse> {
    const verificationToken = randomBytes(32).toString('base64url');
    try {
      const ttl = Number(
        await this.redis.getClient().eval(MOBISHASTRA_CHALLENGE_SCRIPT, {
          keys: [key],
          arguments: [
            'verify',
            challenge.requestId,
            this.digest(phone, challenge.requestId, code),
            this.proofHash(phone, verificationToken),
          ],
        }),
      );
      return ttl > 0
        ? {
            valid: true,
            status: 'VALID',
            verificationToken,
            expiresInSeconds: Math.floor(ttl / 1000),
          }
        : { valid: false, status: 'INVALID' };
    } catch {
      throw new ServiceUnavailableException(
        'Vérification OTP momentanément indisponible.',
      );
    }
  }

  async consumeProof(
    phone: string,
    token: string,
    key: string,
  ): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    try {
      return (
        (await this.redis.getClient().eval(MOBISHASTRA_CHALLENGE_SCRIPT, {
          keys: [key],
          arguments: ['consume-proof', this.proofHash(phone, token)],
        })) === 1
      );
    } catch {
      throw new ServiceUnavailableException(
        'Vérification OTP momentanément indisponible.',
      );
    }
  }
}
