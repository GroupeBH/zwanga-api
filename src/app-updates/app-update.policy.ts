export type AppPlatform = 'ios' | 'android';
export interface AppRelease {
  id: string; platform: AppPlatform; version: string; build: string;
  notes: string; available: boolean; publishedAt: string;
}
export const VERSION_PATTERN = /^\d{1,10}(\.\d{1,10}){0,2}$/;
export function normalizeAppVersion(value: string): string | null {
  if (!VERSION_PATTERN.test(value)) return null;
  const parts = value.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part) || part > 2147483647)) return null;
  while (parts.length < 3) parts.push(0);
  return parts.join('.');
}
export const UPDATE_REQUIRED_SQL = `(string_to_array(c.version, '.')::int[] < string_to_array(r.version, '.')::int[]
  OR (c.version = r.version AND string_to_array(c.build, '.')::int[] < string_to_array(r.build, '.')::int[]))`;
export const UPDATE_CLIENT_ELIGIBLE_SQL = `r.available = true AND c.platform = r.platform
  AND u."isActive" = true AND u."fcmToken" IS NOT NULL AND c."tokenHash" IS NOT NULL
  AND c."tokenHash" = encode(sha256(convert_to(u."fcmToken", 'UTF8')), 'hex')
  AND ${UPDATE_REQUIRED_SQL}`;
