import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Agent, AgentOptions } from 'node:https';
import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { mobishastraProxy } from '../otp/mobishastra-proxy';
import { SmsMarketingConfig } from './sms.config';
import { smsLength } from './sms.policy';

export type SmsResult = { accepted: true } | { accepted: false; code: string };
export function marketingResult(status: number, body: unknown): SmsResult {
  if (status !== 200 || typeof body !== 'string')
    return { accepted: false, code: 'PROVIDER_NOT_CONFIRMED' };
  const value = body.trim();
  if (/^(000(?:\s*-\s*Send Successful)?|Send Successful)$/i.test(value))
    return { accepted: true };
  const responses: Record<string, string> = {
    'No More Credits': 'INSUFFICIENT_CREDITS',
    'Invalid Mobile No': 'INVALID_NUMBER',
    'Enter Mobile Number.': 'INVALID_NUMBER',
    'Invalid Password': 'PROVIDER_REJECTED',
    'Profile Id Blocked': 'PROVIDER_REJECTED',
    'Submission Stops': 'PROVIDER_REJECTED',
    'Enter text message': 'PROVIDER_REJECTED',
    'Invalid Profile Id.': 'PROVIDER_REJECTED',
    'Country not activated': 'OPERATOR_REJECTED',
  };
  const coded: Record<string, [string, string]> = {
    '001': ['Invalid Receiver', 'INVALID_NUMBER'],
    '003': ['Invalid Message', 'PROVIDER_REJECTED'],
    '005': ['Authorization failed', 'PROVIDER_REJECTED'],
    '006': ['DND Number', 'OPERATOR_REJECTED'],
    '007': ['Cannot Extract Country Code', 'INVALID_NUMBER'],
    '008': ['Empty Receiver', 'INVALID_NUMBER'],
    '009': ['Profile Blocked', 'PROVIDER_REJECTED'],
    '010': ['Invalid Profile ID', 'PROVIDER_REJECTED'],
    '011': ['Profile ID expired', 'PROVIDER_REJECTED'],
    '012': ['Sender Id more than 13 Chars', 'SENDER_NOT_APPROVED'],
    '013': ['Server Error', 'PROVIDER_UNAVAILABLE'],
  };
  for (const [code, [label, result]] of Object.entries(coded)) {
    if (
      value === code ||
      value.toLowerCase() === `${code} - ${label}`.toLowerCase()
    )
      return { accepted: false, code: result };
  }
  return {
    accepted: false,
    code: responses[value] ?? 'PROVIDER_NOT_CONFIRMED',
  };
}

/** Separate connection pool, no OTP code, budgets or fallback touched. */
@Injectable()
export class MobishastraMarketingTransport implements OnModuleDestroy {
  private agent?: Agent;
  constructor(
    private readonly config: SmsMarketingConfig,
    private readonly http: HttpService,
  ) {}
  configured(): boolean {
    try {
      this.settings();
      return true;
    } catch {
      return false;
    }
  }
  private settings() {
    const env = this.config.env;
    const sender = this.config.sender;
    const user = env.get<string>('MOBISHASTRA_PROFILE_ID');
    const pwd = env.get<string>('MOBISHASTRA_PASSWORD');
    const url =
      env.get<string>('MOBISHASTRA_SMS_URL') ||
      'https://mshastra.com/sendurl.aspx';
    const proxy = mobishastraProxy(
      env.get('MOBISHASTRA_PROXY_URL'),
      true,
      env.get('NODE_ENV'),
    );
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (
      !this.config.approved ||
      !sender ||
      sender.length > 13 ||
      !user ||
      !pwd ||
      !proxy ||
      !this.config.baseUrl ||
      url !== 'https://mshastra.com/sendurl.aspx' ||
      major < 24 ||
      (major === 24 && minor < 5)
    )
      throw new Error('SMS_CONFIGURATION');
    return { sender, user, pwd, url, proxy };
  }
  async send(phone: string, text: string): Promise<SmsResult> {
    // The PDF does not resolve the encoding of accented GSM letters on sendurl.
    // Refuse rather than silently transliterate or invent an undocumented flag.
    if (!/^\+[1-9]\d{6,14}$/.test(phone))
      return { accepted: false, code: 'INVALID_NUMBER' };
    if (!/^[\x20-\x7e\r\n]+$/.test(text) || smsLength(text).segments > 1)
      return { accepted: false, code: 'SMS_ENCODING_UNCONFIRMED' };
    try {
      const s = this.settings();
      if (!this.agent) {
        const options: AgentOptions & { proxyEnv: Record<string, string> } = {
          keepAlive: true,
          maxSockets: 2,
          maxTotalSockets: 2,
          maxFreeSockets: 1,
          timeout: 10000,
          rejectUnauthorized: true,
          proxyEnv: { https_proxy: `http://${s.proxy.host}:${s.proxy.port}` },
        };
        this.agent = new Agent(options);
      }
      const response = await context.with(
        suppressTracing(context.active()),
        () =>
          firstValueFrom(
            this.http.get(s.url, {
              params: {
                user: s.user,
                pwd: s.pwd,
                senderid: s.sender,
                mobileno: phone.slice(1),
                msgtext: text,
                priority: 'High',
                CountryCode: 'ALL',
                ShowError: 'C',
              },
              adapter: 'http',
              proxy: false,
              httpsAgent: this.agent,
              signal: AbortSignal.timeout(10000),
              timeout: 10000,
              maxRedirects: 0,
              maxContentLength: 16384,
              maxBodyLength: 4096,
              responseType: 'text',
              headers: { Accept: 'text/plain', 'Cache-Control': 'no-store' },
            }),
          ),
      );
      return marketingResult(response.status, response.data);
    } catch {
      // Never expose or retry Axios errors: acceptance may already have happened.
      return { accepted: false, code: 'PROVIDER_NOT_CONFIRMED' };
    }
  }
  onModuleDestroy() {
    this.agent?.destroy();
  }
}
