import { createHash, randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/services/redis.service';
import { KeccelOtpService } from '../keccel-otp/keccel-otp.service';
import { OTP_SMS_MESSAGES } from '../keccel-otp/otp-messages';
import { normalizeOtpPhone } from './otp-phone.util';
import { reserveOtpSend } from './otp-send-budget';
import { MobishastraOtpService } from './mobishastra-otp.service';
import {
  OtpChallenge,
  OtpPurpose,
  SendOtpResponse,
  VerifyOtpResponse,
} from './otp.types';

const DEFAULT_OTP_TTL_SECONDS = 300;
const OTP_PURPOSES: OtpPurpose[] = [
  'phone_verification',
  'pin_reset',
  'admin_bootstrap',
];
// Exceeds the provider's bounded request duration, including Redis bookkeeping.
const OPERATION_LOCK_SECONDS = 120;

@Injectable()
export class OtpService {
  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly keccelOtpService: KeccelOtpService,
    @Optional() private readonly mobishastraOtpService?: MobishastraOtpService,
  ) {}

  async sendOtp(
    phone: string,
    purpose: OtpPurpose = 'phone_verification',
  ): Promise<SendOtpResponse> {
    const normalizedPhone = this.normalizePhone(phone);
    return this.withPhoneLock(normalizedPhone, async () => {
      const useMobishastra =
        purpose === 'phone_verification' &&
        this.configService.get<string>('OTP_PROVIDER')?.trim().toLowerCase() ===
          'mobishastra';
      if (useMobishastra) this.mobishastra().assertConfigured();
      // A denied resend must not invalidate the still-usable previous code.
      await reserveOtpSend(
        this.redisService,
        this.configService,
        normalizedPhone,
      );
      // Legacy Didit settings still route to Keccel. Mobishastra is an explicit
      // opt-in for phone verification only; PIN reset/admin remain unchanged.
      const message =
        purpose === 'pin_reset'
          ? OTP_SMS_MESSAGES.pinReset
          : purpose === 'admin_bootstrap'
            ? OTP_SMS_MESSAGES.adminBootstrap
            : OTP_SMS_MESSAGES.verification;
      const length = purpose === 'phone_verification' ? 5 : 6;
      // Invalidate before contacting Keccel: a timeout can happen after it has
      // generated a code. Never leave that new code bound to an older purpose.
      for (const previousPurpose of OTP_PURPOSES) {
        await this.redisService.del(
          this.challengeKey(normalizedPhone, previousPurpose),
        );
      }
      if (useMobishastra) {
        return this.mobishastra().send(
          normalizedPhone,
          this.challengeKey(normalizedPhone, purpose),
        );
      }
      const response = await this.keccelOtpService.sendOtp(
        phone,
        message,
        length,
        DEFAULT_OTP_TTL_SECONDS,
      );
      if (!response.success) {
        throw new ServiceUnavailableException(
          'Service OTP temporairement indisponible',
        );
      }

      // Keccel validates by phone, not by business purpose. Only the latest
      // successful send can be used, and never through another purpose's route.
      await this.redisService.set(
        this.challengeKey(normalizedPhone, purpose),
        { provider: 'keccel', requestId: randomUUID() } satisfies OtpChallenge,
        DEFAULT_OTP_TTL_SECONDS,
      );
      return response;
    });
  }

  async verifyOtp(
    phone: string,
    otp: string,
    purpose: OtpPurpose = 'phone_verification',
  ): Promise<VerifyOtpResponse> {
    if (!otp || !/^\d{4,8}$/.test(otp.trim())) {
      throw new BadRequestException('Code OTP invalide');
    }
    const normalizedPhone = this.normalizePhone(phone);
    return this.withPhoneLock(normalizedPhone, async () => {
      const invalid: VerifyOtpResponse = { valid: false, status: 'INVALID' };
      const key = this.challengeKey(normalizedPhone, purpose);
      const stored = await this.redisService.get<OtpChallenge>(key);

      // Verify with the issuing provider, even if configuration changed since
      // sending. Local registration codes must never authorize PIN/admin flows.
      if (
        stored?.provider === 'mobishastra' &&
        purpose === 'phone_verification'
      ) {
        return this.mobishastra().verify(
          normalizedPhone,
          otp.trim(),
          key,
          stored,
        );
      }

      // A code issued by Didit cannot be validated by Keccel. Request a fresh
      // SMS instead of consulting Didit or accepting an unbound provider code.
      if (stored?.provider !== 'keccel') return invalid;

      // Old replicas could have issued multiple Keccel purposes for one phone.
      // Their provider response cannot distinguish those codes: fail closed.
      for (const other of OTP_PURPOSES) {
        if (other !== purpose) {
          const challenge = await this.redisService.get<OtpChallenge>(
            this.challengeKey(normalizedPhone, other),
          );
          if (challenge?.provider === 'keccel') return invalid;
        }
      }

      const result = await this.keccelOtpService.verifyOtp(phone, otp.trim());
      if (!result.valid) return invalid;

      const consumed = await this.redisService.consumeIfValueMatches(
        key,
        stored,
      );
      return { valid: consumed, status: consumed ? 'VALID' : 'INVALID' };
    });
  }

  private normalizePhone(phone: string): string {
    return normalizeOtpPhone(
      phone,
      this.configService.get<string>('DEFAULT_COUNTRY_CODE') || '+243',
    );
  }

  async consumePhoneVerificationProof(
    phone: string,
    token: string,
  ): Promise<boolean> {
    const normalized = this.normalizePhone(phone);
    return this.withPhoneLock(normalized, () =>
      this.mobishastra().consumeProof(
        normalized,
        token,
        this.challengeKey(normalized, 'phone_verification'),
      ),
    );
  }

  private mobishastra(): MobishastraOtpService {
    if (!this.mobishastraOtpService) {
      throw new ServiceUnavailableException(
        'Service OTP momentanément indisponible.',
      );
    }
    return this.mobishastraOtpService;
  }

  private challengeKey(phone: string, purpose: OtpPurpose): string {
    const phoneHash = createHash('sha256').update(phone).digest('hex');
    return `otp:challenge:v1:${purpose}:${phoneHash}`;
  }

  private async withPhoneLock<T>(
    phone: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const phoneHash = createHash('sha256').update(phone).digest('hex');
    const key = `otp:operation:v1:${phoneHash}`;
    const token = randomUUID();
    const acquired = await this.redisService
      .getClient()
      .set(key, JSON.stringify(token), {
        NX: true,
        EX: OPERATION_LOCK_SECONDS,
      });
    if (!acquired) {
      throw new ConflictException(
        'Une vérification OTP est en cours. Réessayez dans quelques instants.',
      );
    }
    try {
      return await operation();
    } finally {
      await this.redisService.consumeIfValueMatches(key, token);
    }
  }
}
