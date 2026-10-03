import { createHmac, timingSafeEqual } from 'crypto';

export const isLocalUploadKey = (key: string) => /^(profiles|vehicles|kyc)\/[a-f0-9-]+\.(jpe?g|png|webp)$/i.test(key);
export function signLocalUpload(key: string, expires: number, secret: string) {
  if (!secret || !isLocalUploadKey(key)) throw new Error('Invalid local upload signing configuration');
  return createHmac('sha256', secret).update(`zwanga-local-upload:v1:${key}:${expires}`).digest('hex');
}
export function verifyLocalUpload(key: string, expires: unknown, signature: unknown, secret: string) {
  if (!secret || !isLocalUploadKey(key) || typeof expires !== 'string' || !/^\d{10}$/.test(expires) ||
      typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Number(expires) <= now || Number(expires) > now + 3600) return false;
  const expected = signLocalUpload(key, Number(expires), secret);
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
