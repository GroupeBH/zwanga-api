import { Injectable } from '@nestjs/common';
import axios, { AxiosRequestConfig } from 'axios';
import { lookup } from 'node:dns/promises';
import { Agent } from 'node:https';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import {
  isPublicMediaAddress,
  mediaUrl,
} from '../users/kyc-evidence/kyc-evidence.transport';
import { StoreProviderError } from './store.types';

const MAX_BYTES = 12 * 1024 * 1024;
const unzip = promisify(gunzip);
const API_HOSTS = [
  'androidpublisher.googleapis.com',
  'playdeveloperreporting.googleapis.com',
  'storage.googleapis.com',
  'api.appstoreconnect.apple.com',
];

export function providerFailure(
  error: unknown,
  write = false,
): StoreProviderError {
  if (error instanceof StoreProviderError) return error;
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  const retry = axios.isAxiosError(error)
    ? error.response?.headers?.['retry-after']
    : undefined;
  const retrySeconds = /^\d+$/.test(String(retry))
    ? Number(retry)
    : Math.ceil((Date.parse(String(retry)) - Date.now()) / 1000);
  const delay = Number.isFinite(retrySeconds)
    ? Math.min(86400, Math.max(0, retrySeconds))
    : 0;
  const transient = !status || status === 429 || status >= 500;
  const code =
    status === 401
      ? 'PROVIDER_AUTH_FAILED'
      : status === 403
        ? 'PROVIDER_PERMISSION_DENIED'
        : status === 404
          ? 'PROVIDER_DATA_UNAVAILABLE'
          : status === 429
            ? 'PROVIDER_RATE_LIMITED'
            : transient
              ? 'PROVIDER_TEMPORARILY_UNAVAILABLE'
              : 'PROVIDER_REQUEST_REJECTED';
  return new StoreProviderError(
    code,
    transient && !write,
    delay,
    write && transient,
  );
}

@Injectable()
export class StoreHttp {
  async api<T = any>(
    url: string,
    token: string,
    options: AxiosRequestConfig = {},
  ): Promise<T> {
    try {
      mediaUrl(url, API_HOSTS);
      const response = await axios.request<T>({
        ...options,
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: String(options.headers?.Accept ?? 'application/json'),
        },
        timeout: 15000,
        signal: options.signal ?? AbortSignal.timeout(20000),
        maxRedirects: 0,
        maxContentLength: MAX_BYTES,
        maxBodyLength: 65536,
        proxy: false,
      });
      return response.data;
    } catch (error) {
      // POST ...:query is read-only. Never automatically replay actual remote writes.
      throw providerFailure(
        error,
        options.method !== undefined &&
          options.method !== 'GET' &&
          !url.endsWith(':query'),
      );
    }
  }

  async report(
    url: string,
    hosts: string[],
    signal: AbortSignal,
  ): Promise<Buffer> {
    let timer: NodeJS.Timeout | undefined;
    let agent: Agent | undefined;
    try {
      const parsed = mediaUrl(url, hosts);
      const addresses = await Promise.race([
        lookup(parsed.hostname, { all: true, family: 4 }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('DNS_TIMEOUT')), 5000);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (
        !addresses.length ||
        addresses.some((a) => !isPublicMediaAddress(a.address))
      )
        throw new StoreProviderError('REPORT_ADDRESS_REJECTED');
      agent = new Agent({
        // Pin the validated IPv4 address. Node's automatic family selection
        // otherwise requests an array from lookup instead of a single address.
        family: 4,
        lookup: (_host, _options, callback) =>
          callback(null, addresses[0].address, 4),
      });
      const response = await axios.get<ArrayBuffer>(url, {
        httpsAgent: agent,
        responseType: 'arraybuffer',
        timeout: 15000,
        signal,
        maxRedirects: 0,
        maxContentLength: MAX_BYTES,
        proxy: false,
        // Signed URLs authorize the download. NEVER forward the Apple JWT.
        headers: { Accept: 'application/octet-stream' },
      });
      return Buffer.from(response.data);
    } catch (error) {
      throw providerFailure(error);
    } finally {
      agent?.destroy();
    }
  }
}

export async function decodeReport(bytes: Buffer): Promise<string> {
  try {
    const data =
      bytes[0] === 0x1f && bytes[1] === 0x8b
        ? await unzip(bytes, { maxOutputLength: MAX_BYTES })
        : bytes;
    if (data.length > MAX_BYTES) throw new Error('TOO_LARGE');
    if (data[0] === 0xff && data[1] === 0xfe)
      return data.subarray(2).toString('utf16le');
    if (data[0] === 0xfe && data[1] === 0xff)
      return Buffer.from(data.subarray(2)).swap16().toString('utf16le');
    // Some Google UTF-16LE exports omit a BOM.
    if (data[1] === 0) return data.toString('utf16le');
    return data.toString('utf8').replace(/^\uFEFF/, '');
  } catch {
    throw new StoreProviderError('REPORT_ENCODING_OR_SIZE_INVALID');
  }
}
