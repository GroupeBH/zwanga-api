import { ServiceUnavailableException } from '@nestjs/common';
import type { AxiosProxyConfig } from 'axios';
import { isIPv4 } from 'node:net';

/** Operator-only setting. No DNS, credentials, public hosts or URL rewriting. */
export function mobishastraProxy(
  value: string | undefined,
  required: string | boolean | undefined,
  environment: string | undefined,
): AxiosProxyConfig | false {
  const fail = (): never => {
    throw new ServiceUnavailableException({
      code: 'OTP_SMS_PROXY_MISCONFIGURED',
      message: 'Le service SMS est momentanément indisponible.',
    });
  };
  if (![undefined, '', true, false, 'true', 'false'].includes(required)) fail();
  const raw = value?.trim();
  if (!raw) {
    if (required === true || required === 'true') fail();
    // Explicitly ignore HTTP(S)_PROXY/NO_PROXY for this transport only.
    return false;
  }
  const match = /^http:\/\/([0-9.]+):([0-9]{1,5})\/?$/.exec(raw);
  if (!match || !isIPv4(match[1])) return fail();
  const host = match[1];
  const [a, b] = host.split('.').map(Number);
  const privateIp =
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  const localTest =
    host === '127.0.0.1' && ['development', 'test'].includes(environment ?? '');
  const port = Number(match[2]);
  if ((!privateIp && !localTest) || port < 1 || port > 65535) return fail();
  return { protocol: 'http', host, port };
}
