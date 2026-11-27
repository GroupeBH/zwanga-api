import { HttpException } from '@nestjs/common';
import { randomInt } from 'node:crypto';

export const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
export const GSM_EXTENDED = '^{}\\[~]|€\f';
export const SMS_PERMISSIONS = [
  'sms.read',
  'sms.write',
  'sms.send',
  'sms.optouts.manage',
] as const;
export type SmsPermission = (typeof SMS_PERMISSIONS)[number];
export function permissions(role: string): readonly SmsPermission[] {
  return ['admin', 'super_admin'].includes(role)
    ? SMS_PERMISSIONS
    : role === 'marketer'
      ? ['sms.read', 'sms.write']
      : [];
}
export function smsError(code: string, message: string, status = 400): never {
  throw new HttpException({ code, message }, status);
}
export function smsLength(text: string) {
  let units = 0;
  let unicode = false;
  for (const char of text) {
    if (GSM_BASIC.includes(char)) units++;
    else if (GSM_EXTENDED.includes(char)) units += 2;
    else unicode = true;
  }
  if (unicode) units = text.length;
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  return {
    encoding: unicode ? 'unicode' : 'gsm',
    units,
    segments: units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi),
  };
}
export function renderSms(
  message: string,
  firstName: string | null,
  suffix: string,
): string {
  // Twenty UTF-16 units, like the admin length counter, without splitting an emoji.
  let name = '';
  for (const char of (firstName ?? '').trim().split(/\s+/u)[0]) {
    if (name.length + char.length > 20) break;
    name += char;
  }
  return (
    message
      .replace(/\s*\{prenom\}/gi, (match) =>
        name ? match.replace(/\{prenom\}/i, () => name) : '',
      )
      .replace(/\s+([,.;!?])/g, '$1')
      .trimEnd() + suffix
  );
}
export function validateMessage(
  message: string,
  suffix: string,
  maxSegments = 1,
): void {
  if (!message.trim()) smsError('SMS_INVALID_MESSAGE', 'Saisissez un message.');
  if (/[{}]/.test(message.replace(/\{prenom\}/gi, '')))
    smsError('SMS_UNKNOWN_PLACEHOLDER', 'Seul le champ {prenom} est autorisé.');
  // Names can contain extended GSM characters or Unicode.
  // Unlike an ASCII placeholder preview, neither case may exceed the configured cap.
  const variants = message.match(/\{prenom\}/i)
    ? ['^'.repeat(20), '😀'.repeat(20)]
    : [''];
  if (
    variants.some(
      (name) =>
        smsLength(renderSms(message, name, suffix)).segments > maxSegments,
    )
  )
    smsError(
      'SMS_MESSAGE_TOO_LONG',
      'Le message personnalisé et son lien dépassent la longueur autorisée.',
    );
}
export function optOutCode(): string {
  const alphabet =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  return Array.from({ length: 8 }, () => alphabet[randomInt(62)]).join('');
}
export function maskPhone(phone: string | null): string | null {
  return phone
    ? `${phone.slice(0, Math.min(6, phone.length - 3))}••••${phone.slice(-3)}`
    : null;
}
export function inSendingWindow(
  now: Date,
  start: string,
  end: string,
): boolean {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Kinshasa',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return time >= start && time < end;
}
