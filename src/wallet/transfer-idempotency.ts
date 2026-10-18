import { createHash } from 'crypto';

/** Sender-scoped, deterministic UUID: a key cannot replay another account's transfer. */
export function walletTransferId(senderId: string, key: string): string {
  const bytes = createHash('sha256').update(`zwanga:wallet-transfer:${senderId}:${key.toLowerCase()}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
