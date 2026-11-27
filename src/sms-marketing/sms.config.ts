import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { inSendingWindow, smsError, smsLength } from './sms.policy';

@Injectable()
export class SmsMarketingConfig {
  constructor(readonly env: ConfigService) {}
  get enabled() {
    return this.env.get('SMS_MARKETING_ENABLED') === 'true';
  }
  number(name: string, fallback: number, max: number) {
    const n = Number(this.env.get(`SMS_MARKETING_${name}`) ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > max)
      smsError(
        'SMS_NOT_CONFIGURED',
        'La configuration SMS doit être vérifiée.',
        503,
      );
    return n;
  }
  get frequencyDays() {
    return this.number('FREQUENCY_CAP_DAYS', 3, 365);
  }
  get maxRecipients() {
    return this.number('MAX_RECIPIENTS', 50000, 50000);
  }
  get rate() {
    return this.number('RATE_PER_SECOND', 2, 20);
  }
  get dailyLimit() {
    return this.number('DAILY_LIMIT', 20000, 1000000);
  }
  get credits() {
    return this.number('CREDITS_PER_SEGMENT', 1, 1000);
  }
  get pauseAfter() {
    return this.number('PAUSE_AFTER_FAILURES', 20, 100);
  }
  get sender() {
    return this.env.get<string>('SMS_MARKETING_SENDER_ID')?.trim() || null;
  }
  // Do not infer promotional approval from the OTP sender or a generic API PDF.
  get approved() {
    return this.env.get('SMS_MARKETING_PROVIDER_CONFIRMED') === 'true';
  }
  get baseUrl(): string | null {
    const raw = this.env.get<string>('SMS_MARKETING_OPT_OUT_BASE_URL')?.trim();
    if (!raw) return null;
    try {
      const u = new URL(raw);
      const domain = this.env.get<string>('SMS_MARKETING_LINK_HOST')?.trim();
      if (
        !domain ||
        u.hostname !== domain ||
        u.protocol !== 'https:' ||
        u.port ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        !raw.endsWith('/') ||
        raw.length > 100 ||
        smsLength(raw).encoding !== 'gsm'
      )
        return null;
      return raw;
    } catch {
      return null;
    }
  }
  suffix(code = 'Ab3dE9xK') {
    return ` Stop SMS: ${this.baseUrl ?? 'https://domaine-a-configurer.invalid/s/'}${code}`;
  }
  get window() {
    const raw =
      this.env.get<string>('SMS_MARKETING_SENDING_WINDOW') ?? '08:00-20:00';
    if (
      !/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(raw) ||
      raw.slice(0, 5) >= raw.slice(6)
    )
      smsError(
        'SMS_NOT_CONFIGURED',
        'La plage horaire SMS doit être vérifiée.',
        503,
      );
    return {
      start: raw.slice(0, 5),
      end: raw.slice(6),
      timezone: 'Africa/Kinshasa',
    };
  }
  open(now = new Date()) {
    const w = this.window;
    return inSendingWindow(now, w.start, w.end);
  }
  assertEnabled() {
    if (!this.enabled)
      smsError('SMS_DISABLED', 'Les campagnes SMS sont désactivées.', 503);
  }
}
