import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

// A short-lived receipt, never a second valid session. Replay still requires
// the current DB token fingerprints and the original client attempt ID.
export const REFRESH_RECOVERY_SECONDS = 120;

function key(secret: string): Buffer {
  if (!secret)
    throw new Error('Refresh recovery requires the configured signing secret');
  return createHash('sha256')
    .update(`zwanga:refresh-recovery:v1:${secret}`)
    .digest();
}

export function sealRefreshReceipt(value: unknown, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function openRefreshReceipt<T>(value: string, secret: string): T {
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(secret),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString('utf8'),
  ) as T;
}
