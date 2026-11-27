import { Injectable } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { get } from 'https';
import { Readable } from 'stream';
import { isPublicMediaAddress, mediaUrl } from './kyc-evidence.transport';
import {
  PROVIDER_DATA_MAX_BYTES,
  ORIGINAL_FILES_MAX_BYTES,
  REPORT_MAX_BYTES,
} from './didit-archive.policy';

// Only this fixed API origin receives the provider credential. Never accept an
// API URL from a callback/decision or follow a redirect with that credential.
@Injectable()
export class DiditArchiveTransport {
  private async api(
    path: string,
    apiKey: string,
    maxBytes: number,
    request?: { method: string; idempotencyKey: string },
  ): Promise<Buffer> {
    const response = await fetch(`https://verification.didit.me/v3/${path}`, {
      method: request?.method ?? 'GET',
      redirect: 'error',
      headers: {
        'x-api-key': apiKey,
        Accept: path.includes('generate-pdf')
          ? 'application/pdf'
          : 'application/json',
        ...(request ? { 'Idempotency-Key': request.idempotencyKey } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(
        response.status === 404
          ? 'PROVIDER_NOT_AVAILABLE'
          : 'PROVIDER_READ_FAILED',
      );
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) throw new Error('PROVIDER_TOO_LARGE');
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
  private session(id: string) {
    return `session/${encodeURIComponent(id)}/`;
  }
  async decision(id: string, key: string, expanded = false): Promise<unknown> {
    return JSON.parse(
      (
        await this.api(
          `${this.session(id)}decision/${expanded ? '?include=events,resubmissions' : ''}`,
          key,
          PROVIDER_DATA_MAX_BYTES,
        )
      ).toString(),
    );
  }
  async user(id: string, key: string): Promise<unknown> {
    return JSON.parse(
      (
        await this.api(
          `users/${encodeURIComponent(id)}/`,
          key,
          PROVIDER_DATA_MAX_BYTES,
        )
      ).toString(),
    );
  }
  async startExport(
    id: string,
    key: string,
    operationId: string,
  ): Promise<unknown> {
    return JSON.parse(
      (
        await this.api(`${this.session(id)}files-export/`, key, 64 * 1024, {
          method: 'POST',
          idempotencyKey: operationId,
        })
      ).toString(),
    );
  }
  async exportStatus(
    id: string,
    exportId: string,
    key: string,
  ): Promise<unknown> {
    return JSON.parse(
      (
        await this.api(
          `${this.session(id)}files-export/${encodeURIComponent(exportId)}/`,
          key,
          64 * 1024,
        )
      ).toString(),
    );
  }
  report(id: string, key: string) {
    return this.api(
      `${this.session(id)}generate-pdf/?language=fr`,
      key,
      REPORT_MAX_BYTES,
    );
  }

  async originals(
    value: string,
    hosts: string[],
    expectedSize: number,
  ): Promise<Readable> {
    if (
      !Number.isSafeInteger(expectedSize) ||
      expectedSize <= 0 ||
      expectedSize > ORIGINAL_FILES_MAX_BYTES
    )
      throw new Error('ORIGINAL_FILES_TOO_LARGE');
    const url = mediaUrl(value, hosts);
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
          signal: AbortSignal.timeout(90_000),
          lookup: (_host, _options, callback) =>
            callback(null, addresses[0].address, 4),
          headers: { Accept: 'application/zip,application/octet-stream' },
        },
        (response) => {
          if (
            response.statusCode !== 200 ||
            !/^application\/(zip|x-zip-compressed|octet-stream)(?:;|$)/i.test(
              response.headers['content-type'] ?? '',
            ) ||
            (response.headers['content-length'] !== undefined &&
              Number(response.headers['content-length']) !== expectedSize)
          ) {
            response.destroy();
            reject(new Error('EXPORT_DOWNLOAD_REJECTED'));
            return;
          }
          // A sanitized handler is installed even before the downstream starts.
          response.on('error', () => undefined);
          resolve(response);
        },
      );
      request.on('error', () => reject(new Error('EXPORT_DOWNLOAD_FAILED')));
    });
  }
}
