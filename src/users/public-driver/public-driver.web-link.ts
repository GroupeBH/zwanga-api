import { ServiceUnavailableException } from '@nestjs/common';

/** Deployment configuration only: never trust request Host, query or forwarded headers. */
export function publicDriverWebLink(
  configured: string | undefined,
  id: string,
): string {
  try {
    const url = new URL(configured?.trim() || 'https://zwanga-app.com');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    )
      throw Error();
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/conducteurs/${encodeURIComponent(id.toLowerCase())}`;
    return url.href;
  } catch {
    throw new ServiceUnavailableException(
      'La fiche web est momentanément indisponible.',
    );
  }
}
