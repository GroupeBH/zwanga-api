import {
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { RedisService } from '../common/services/redis.service';
import { AuthResponseDto } from './dto/auth.dto';

const CODE_TTL_SECONDS = 60;
const CODE_KEY_PREFIX = 'auth:oauth-exchange:';
const INVALID_CODE_MESSAGE = 'Code de connexion invalide ou expiré.';
const STORAGE_UNAVAILABLE_MESSAGE =
  'La connexion est temporairement indisponible. Veuillez réessayer.';

@Injectable()
export class OAuthExchangeService {
  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  getFrontendCallbackUrl(): URL {
    const production =
      this.configService.get<string>('NODE_ENV') === 'production';
    const configuredUrl = this.configService
      .get<string>('FRONTEND_URL')
      ?.trim();
    let url: URL;
    try {
      // A missing production target must never send credentials to localhost.
      if (!configuredUrl && production) {
        throw new Error('Missing frontend URL');
      }
      url = new URL(configuredUrl || 'http://localhost:3000');
      const localDevelopment =
        !production &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        (url.protocol !== 'https:' && !localDevelopment) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error('Invalid frontend URL');
      }
    } catch {
      // Do not include configuration values in responses or application logs.
      throw new InternalServerErrorException(
        'Configuration FRONTEND_URL invalide.',
      );
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/auth/callback`;
    return url;
  }

  async createCode(tokens: AuthResponseDto): Promise<string> {
    const code = randomBytes(32).toString('hex');
    try {
      // The raw exchange code is not part of the Redis key or stored value.
      await this.redisService.set(
        this.keyForCode(code),
        tokens,
        CODE_TTL_SECONDS,
      );
    } catch {
      // Never fall back to exposing JWTs in a URL when Redis is unavailable.
      throw new ServiceUnavailableException(STORAGE_UNAVAILABLE_MESSAGE);
    }
    return code;
  }

  async exchange(code: string): Promise<AuthResponseDto> {
    if (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code)) {
      throw new UnauthorizedException(INVALID_CODE_MESSAGE);
    }
    let tokens: AuthResponseDto | null;
    try {
      // GETDEL is atomic across all backend instances (unlike GET followed by DEL).
      tokens = await this.redisService.consume<AuthResponseDto>(
        this.keyForCode(code),
      );
    } catch {
      throw new ServiceUnavailableException(STORAGE_UNAVAILABLE_MESSAGE);
    }
    if (
      !tokens ||
      typeof tokens.accessToken !== 'string' ||
      !tokens.accessToken ||
      typeof tokens.refreshToken !== 'string' ||
      !tokens.refreshToken
    ) {
      throw new UnauthorizedException(INVALID_CODE_MESSAGE);
    }
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      ...(typeof tokens.passwordChangeRequired === 'boolean'
        ? { passwordChangeRequired: tokens.passwordChangeRequired }
        : {}),
    };
  }

  private keyForCode(code: string): string {
    return CODE_KEY_PREFIX + createHash('sha256').update(code).digest('hex');
  }
}
