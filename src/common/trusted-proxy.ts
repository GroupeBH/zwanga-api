import { isIP } from 'node:net';

/** No hop-count or blanket trust: direct clients cannot opt into forwarding. */
export function trustedProxyCidrs(value?: string): string[] | false {
  const entries =
    value
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean) ?? [];
  if (!entries.length) return false;
  for (const entry of entries) {
    const [ip, prefix, extra] = entry.split('/');
    const family = isIP(ip);
    if (
      !family ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) ||
          Number(prefix) < 1 ||
          Number(prefix) > (family === 4 ? 32 : 128)))
    )
      throw new Error(
        'TRUSTED_PROXY_CIDRS must contain explicit IP addresses or non-global CIDRs',
      );
  }
  return entries;
}
