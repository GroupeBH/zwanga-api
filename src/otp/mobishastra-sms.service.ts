import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Agent, type AgentOptions } from 'node:https';
import type { AxiosProxyConfig } from 'axios';
import { mobishastraProxy } from './mobishastra-proxy';

const DEFAULT_URL = 'https://valuesms.ae/sendsms_api_json.aspx';
const ALLOWED_URLS = new Set([
  DEFAULT_URL,
  'https://mshastra.com/sendsms_api_json.aspx',
]);

/** SMS transport only. Code generation and validation never leave Zwanga. */
@Injectable()
export class MobishastraSmsService implements OnModuleDestroy {
  private readonly logger = new Logger(MobishastraSmsService.name);
  private httpsAgent?: Agent;
  private agentProxyKey?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  assertConfigured(): void {
    this.settings();
  }

  onModuleDestroy(): void {
    this.httpsAgent?.destroy();
  }

  private transportAgent(proxy: AxiosProxyConfig | false): Agent {
    const key = proxy ? `http://${proxy.host}:${proxy.port}` : '';
    if (!this.httpsAgent || this.agentProxyKey !== key) {
      this.httpsAgent?.destroy();
      // Native CONNECT support in Node >=24.5 (the project requires >=24.22.1).
      // Local proxyEnv, NOT process.env: no global proxy or NO_PROXY inheritance.
      // Explicit type extension until the project's Node 22 types expose it.
      const options: AgentOptions & { proxyEnv: Record<string, string> } = {
        keepAlive: true,
        maxSockets: 8,
        maxTotalSockets: 8,
        maxFreeSockets: 2,
        timeout: 10000,
        rejectUnauthorized: true,
        proxyEnv: key ? { https_proxy: key } : {},
      };
      this.httpsAgent = new Agent(options);
      this.agentProxyKey = key;
    }
    return this.httpsAgent;
  }

  private settings() {
    const user = this.config.get<string>('MOBISHASTRA_PROFILE_ID')?.trim();
    const pwd = this.config.get<string>('MOBISHASTRA_PASSWORD');
    const sender = this.config.get<string>('MOBISHASTRA_SENDER_ID')?.trim();
    const url =
      this.config.get<string>('MOBISHASTRA_SMS_URL')?.trim() || DEFAULT_URL;
    if (
      !user ||
      !pwd ||
      !sender ||
      sender.length > 13 ||
      !ALLOWED_URLS.has(url)
    ) {
      throw new ServiceUnavailableException(
        'Le service SMS est momentanément indisponible.',
      );
    }
    const proxy = mobishastraProxy(
      this.config.get<string>('MOBISHASTRA_PROXY_URL'),
      this.config.get<string | boolean>('MOBISHASTRA_PROXY_REQUIRED'),
      this.config.get<string>('NODE_ENV'),
    );
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (proxy && (major < 24 || (major === 24 && minor < 5))) {
      // Older Node silently ignores proxyEnv: never fall back to direct egress.
      throw new ServiceUnavailableException({
        code: 'OTP_SMS_PROXY_MISCONFIGURED',
        message: 'Le service SMS est momentanément indisponible.',
      });
    }
    return { user, pwd, sender, url, proxy };
  }

  async sendCode(phone: string, code: string): Promise<void> {
    const { url, proxy, ...credentials } = this.settings();
    if (!/^[1-9]\d{6,14}$/.test(phone) || !/^[1-9]\d{4}$/.test(code)) {
      throw new ServiceUnavailableException(
        'Envoi OTP momentanément indisponible.',
      );
    }
    try {
      // PDF v1.3 p.19: JSON array, international digits, English/Unicode.
      // ASCII text fits one GSM SMS. Never put credentials or the code in a URL.
      const result = await firstValueFrom(
        this.http.post<unknown>(
          url,
          [
            {
              ...credentials,
              number: phone,
              msg: `Zwanga : votre code de verification est ${code}. Valable 15 minutes. Ne le partagez avec personne.`,
              language: 'English',
            },
          ],
          {
            // Node owns the tunnel and its lifecycle; Axios must not install a
            // second proxy agent or inherit HTTP(S)_PROXY/NO_PROXY globally.
            adapter: 'http',
            proxy: false,
            httpsAgent: this.transportAgent(proxy),
            // Bounds DNS, proxy negotiation and TLS, not just response inactivity.
            signal: AbortSignal.timeout(10000),
            timeout: 10000,
            maxRedirects: 0,
            maxContentLength: 16 * 1024,
            maxBodyLength: 4096,
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
          },
        ),
      );
      const rows = result.data;
      const candidate: unknown =
        Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
      const row =
        candidate && typeof candidate === 'object'
          ? (candidate as Record<string, unknown>)
          : null;
      if (
        result.status !== 200 ||
        !row ||
        typeof row !== 'object' ||
        String(row.number) !== phone ||
        typeof row.msg_id !== 'string' ||
        !row.msg_id.trim() ||
        typeof row.response !== 'string' ||
        !/^send success(?:ful)?$/i.test(row.response.trim())
      ) {
        throw new Error('SMS_NOT_ACCEPTED');
      }
    } catch {
      // Axios errors contain the request body (password, phone and OTP).
      // HTTP 200 can also contain a provider error. Never log raw errors/data.
      this.logger.warn('MOBISHASTRA_SMS_NOT_CONFIRMED');
      // No automatic retry or fallback: a timeout can follow an accepted SMS.
      throw new ServiceUnavailableException({
        code: 'OTP_SMS_UNAVAILABLE',
        message:
          'Le SMS n’a pas pu être confirmé. Patientez avant de demander un nouveau code.',
      });
    }
  }
}
