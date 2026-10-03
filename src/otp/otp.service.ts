import { createHash, randomUUID } from 'crypto';
import {
  BadRequestException,
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/services/redis.service';
import { KeccelOtpService } from '../keccel-otp/keccel-otp.service';
import { OTP_SMS_MESSAGES } from '../keccel-otp/otp-messages';
import { DiditOtpService } from './didit-otp.service';
import { normalizeOtpPhone } from './otp-phone.util';
import {
  OtpChallenge,
  DiditActiveOtp,
  OtpProvider,
  OtpPurpose,
  SendOtpResponse,
  VerifyOtpResponse,
} from './otp.types';

const DEFAULT_OTP_TTL_SECONDS = 300;

@Injectable()
export class OtpService {
  private readonly provider: OtpProvider;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly keccelOtpService: KeccelOtpService,
    private readonly diditOtpService: DiditOtpService,
  ) {
    const provider = (
      this.configService.get<string>('OTP_PROVIDER') || 'keccel'
    )
      .trim()
      .toLowerCase();
    if (provider !== 'keccel' && provider !== 'didit') {
      throw new Error('OTP_PROVIDER must be keccel or didit');
    }
    this.provider = provider;
  }

  async sendOtp(
    phone: string,
    purpose: OtpPurpose = 'phone_verification',
  ): Promise<SendOtpResponse> {
    const normalizedPhone = this.normalizePhone(phone);
    let challenge: OtpChallenge;
    let response: SendOtpResponse;
    let challengeTtl = DEFAULT_OTP_TTL_SECONDS;
    if (this.provider === 'didit') {
      const active = await this.redisService.get<DiditActiveOtp>(
        this.diditActiveKey(normalizedPhone),
      );
      if (active && active.purpose !== purpose) {
        throw new BadRequestException(
          'Une autre vérification OTP est déjà en cours pour ce numéro',
        );
      }
      const existing = await this.redisService.get<OtpChallenge>(
        this.challengeKey(normalizedPhone, purpose),
      );
      const reusable =
        existing?.provider === 'didit' &&
        active?.purpose === purpose &&
        active.requestId === existing.requestId &&
        active.vendorData === existing.vendorData;
      const vendorData =
        reusable && existing?.provider === 'didit'
          ? existing.vendorData
          : randomUUID();
      const sentAt = Date.now();
      const sent = await this.diditOtpService.sendCode(
        `+${normalizedPhone}`,
        purpose,
        vendorData,
      );
      if (
        sent.status === 'Retry' &&
        (!reusable || sent.requestId !== active?.requestId)
      ) {
        throw new BadGatewayException('Réponse incohérente du service OTP');
      }
      const expiresAt =
        sent.status === 'Retry'
          ? (active?.expiresAt ?? sentAt + 60_000)
          : sentAt + DEFAULT_OTP_TTL_SECONDS * 1000;
      const ttl = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
      challengeTtl = ttl;
      challenge = {
        provider: 'didit',
        requestId: sent.requestId,
        vendorData,
      };
      await this.redisService.set(
        this.diditActiveKey(normalizedPhone),
        {
          purpose,
          requestId: sent.requestId,
          vendorData,
          expiresAt,
        } satisfies DiditActiveOtp,
        ttl,
      );
      response = {
        success: true,
        message: 'Code OTP envoyé avec succès',
        status: 'SENT',
      };
    } else {
      const message =
        purpose === 'pin_reset'
          ? OTP_SMS_MESSAGES.pinReset
          : purpose === 'admin_bootstrap'
            ? OTP_SMS_MESSAGES.adminBootstrap
            : OTP_SMS_MESSAGES.verification;
      const length = purpose === 'phone_verification' ? 5 : 6;
      response = await this.keccelOtpService.sendOtp(
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
      challenge = { provider: 'keccel' };
    }

    await this.redisService.set(
      this.challengeKey(normalizedPhone, purpose),
      challenge,
      challengeTtl,
    );
    return response;
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
    const key = this.challengeKey(normalizedPhone, purpose);
    const stored = await this.redisService.get<OtpChallenge>(key);

    if (
      !stored ||
      (stored.provider !== 'keccel' && stored.provider !== 'didit')
    ) {
      return { valid: false, status: 'INVALID' };
    }

    if (stored.provider === 'didit') {
      const activeKey = this.diditActiveKey(normalizedPhone);
      const active = await this.redisService.get<DiditActiveOtp>(activeKey);
      if (
        active?.purpose !== purpose ||
        active.requestId !== stored.requestId ||
        active.vendorData !== stored.vendorData
      ) {
        return { valid: false, status: 'INVALID' };
      }
      const valid = await this.diditOtpService.verifyCode(
        `+${normalizedPhone}`,
        otp.trim(),
        stored.requestId,
        stored.vendorData,
      );
      if (!valid) return { valid: false, status: 'INVALID' };
      const consumedActive = await this.redisService.consumeIfValueMatches(
        activeKey,
        active,
      );
      const consumedChallenge = consumedActive
        ? await this.redisService.consumeIfValueMatches(key, stored)
        : false;
      return {
        valid: consumedChallenge,
        status: consumedChallenge ? 'VALID' : 'INVALID',
      };
    }

    const valid = (await this.keccelOtpService.verifyOtp(phone, otp)).valid;
    if (!valid) return { valid: false, status: 'INVALID' };

    const consumed = await this.redisService.consumeIfValueMatches(key, stored);
    return { valid: consumed, status: consumed ? 'VALID' : 'INVALID' };
  }

  private normalizePhone(phone: string): string {
    return normalizeOtpPhone(
      phone,
      this.configService.get<string>('DEFAULT_COUNTRY_CODE') || '+243',
    );
  }

  private challengeKey(phone: string, purpose: OtpPurpose): string {
    const phoneHash = createHash('sha256').update(phone).digest('hex');
    return `otp:challenge:v1:${purpose}:${phoneHash}`;
  }

  private diditActiveKey(phone: string): string {
    const phoneHash = createHash('sha256').update(phone).digest('hex');
    return `otp:didit:active:v1:${phoneHash}`;
  }
}
