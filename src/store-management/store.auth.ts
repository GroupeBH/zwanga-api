import { Injectable } from '@nestjs/common';
import { createPrivateKey, sign } from 'node:crypto';
import { JWT } from 'google-auth-library';
import { StoreConfig } from './store.config';
import { StoreProviderError } from './store.types';

@Injectable()
export class StoreAuth {
  private googleClients = new Map<string, JWT>();
  private appleToken?: { value: string; expires: number };
  constructor(private readonly config: StoreConfig) {}

  async google(scope: 'publisher' | 'reporting' | 'storage'): Promise<string> {
    const scopes = {
      publisher: 'androidpublisher',
      reporting: 'playdeveloperreporting',
      storage: 'devstorage.read_only',
    };
    try {
      let client = this.googleClients.get(scope);
      if (!client) {
        client = new JWT({
          email: this.config.value('STORE_GOOGLE_CLIENT_EMAIL'),
          key: this.config
            .value('STORE_GOOGLE_PRIVATE_KEY')
            .replace(/\\n/g, '\n'),
          scopes: [`https://www.googleapis.com/auth/${scopes[scope]}`],
          transporterOptions: { timeout: 15000, retry: false },
        });
        this.googleClients.set(scope, client);
      }
      const result = await client.getAccessToken();
      if (!result.token) throw new Error('NO_TOKEN');
      return result.token;
    } catch {
      throw new StoreProviderError('GOOGLE_AUTH_FAILED');
    }
  }

  apple(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.appleToken && this.appleToken.expires > now + 60)
      return this.appleToken.value;
    try {
      const key = createPrivateKey(
        this.config.value('STORE_APPLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
      );
      if (
        key.asymmetricKeyType !== 'ec' ||
        key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
      )
        throw new Error('NOT_ES256');
      const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const expires = now + 600;
      const unsigned = `${encode({ alg: 'ES256', kid: this.config.value('STORE_APPLE_KEY_ID'), typ: 'JWT' })}.${encode(
        {
          iss: this.config.value('STORE_APPLE_ISSUER_ID'),
          iat: now - 10,
          exp: expires,
          aud: 'appstoreconnect-v1',
        },
      )}`;
      const signature = sign('sha256', Buffer.from(unsigned), {
        key,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url');
      this.appleToken = { value: `${unsigned}.${signature}`, expires };
      return this.appleToken.value;
    } catch {
      throw new StoreProviderError('APPLE_AUTH_CONFIGURATION_INVALID');
    }
  }
}
