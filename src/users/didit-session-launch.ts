import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';

export type DiditLaunchMode = 'native' | 'hosted';

export function diditLaunchMode(value: unknown): DiditLaunchMode {
  const mode = value === undefined || value === null ? 'native' : String(value).trim().toLowerCase();
  if (mode === 'native' || mode === 'hosted') return mode;
  throw new ServiceUnavailableException({
    code: 'KYC_LAUNCH_MODE_INVALID',
    message: 'La vérification d’identité est momentanément indisponible. Le support doit contrôler sa configuration.',
  });
}

export function diditSessionLaunch(mode: DiditLaunchMode, token: string | null, url: string | null) {
  if (mode === 'native') return { sessionToken: token, url: url ?? '' };
  try {
    const parsed = new URL(url ?? '');
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'verify.didit.me' ||
        parsed.username || parsed.password || (parsed.port && parsed.port !== '443') ||
        !/^\/(?:[a-z]{2}\/)?session\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname)) throw new Error('INVALID_URL');
    // Existing mobile builds already use the browser when no SDK token is returned.
    // This must be the same owned session, never a second paid verification.
    return { sessionToken: null, url: parsed.toString() };
  } catch {
    throw new BadGatewayException({
      code: 'KYC_HOSTED_URL_UNAVAILABLE',
      message: 'Le service de vérification n’a pas fourni de lien utilisable. Réessayez plus tard.',
    });
  }
}
