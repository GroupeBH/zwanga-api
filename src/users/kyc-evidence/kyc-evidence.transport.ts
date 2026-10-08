import { Injectable } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { get } from 'https';
import { BlockList, isIP } from 'net';
import { ARCHIVE_MAX_BYTES, MEDIA_MAX_BYTES } from './kyc-evidence.policy';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
export const isPublicMediaAddress = (address: string) =>
  isIP(address) === 4 && !blocked.check(address, 'ipv4');

export function mediaUrl(value: string, hosts: string[]) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('MEDIA_URL_REJECTED');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    isIP(url.hostname) ||
    !hosts.includes(url.hostname.toLowerCase())
  )
    throw new Error('MEDIA_URL_REJECTED');
  return url;
}

@Injectable()
export class KycEvidenceTransport {
  async decision(sessionId: string, apiKey: string): Promise<unknown> {
    const response = await fetch(
      `https://verification.didit.me/v3/session/${encodeURIComponent(sessionId)}/decision/`,
      {
        headers: { 'x-api-key': apiKey, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(
        response.status === 404
          ? 'SESSION_UNAVAILABLE'
          : 'DECISION_UNAVAILABLE',
      );
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > Math.min(ARCHIVE_MAX_BYTES, 2 * 1024 * 1024))
          throw new Error('DECISION_TOO_LARGE');
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }

  async image(value: string, hosts: string[]): Promise<Buffer> {
    const url = mediaUrl(value, hosts);
    // Resolve once, reject private answers, then pin the exact public address.
    // No redirects, credentials, cookies or Didit API key are sent to media hosts.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true, family: 4 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MEDIA_DNS_TIMEOUT')), 5000);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (
      !addresses.length ||
      addresses.some((a) => !isPublicMediaAddress(a.address))
    )
      throw new Error('MEDIA_ADDRESS_REJECTED');
    return new Promise((resolve, reject) => {
      const request = get(
        url,
        {
          agent: false,
          family: 4,
          lookup: (_host, _options, callback) =>
            callback(null, addresses[0].address, 4),
          signal: AbortSignal.timeout(15_000),
          headers: { Accept: 'image/jpeg,image/png,image/webp' },
        },
        (response) => {
          if (
            response.statusCode !== 200 ||
            !/^image\/(jpeg|png|webp)(?:;|$)/i.test(
              response.headers['content-type'] ?? '',
            ) ||
            Number(response.headers['content-length'] ?? 0) > MEDIA_MAX_BYTES
          ) {
            response.destroy();
            reject(new Error('MEDIA_RESPONSE_REJECTED'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MEDIA_MAX_BYTES) {
              response.destroy();
              reject(new Error('MEDIA_TOO_LARGE'));
            } else chunks.push(chunk);
          });
          response.on('end', () => resolve(Buffer.concat(chunks)));
          response.on('error', () =>
            reject(new Error('MEDIA_DOWNLOAD_FAILED')),
          );
        },
      );
      request.on('error', () => reject(new Error('MEDIA_DOWNLOAD_FAILED')));
    });
  }
}
