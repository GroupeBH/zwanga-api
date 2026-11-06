import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createPrivateKey, sign } from 'node:crypto';
import { GoogleAuth, JWT } from 'google-auth-library';
import { StoreConfig } from './store.config';
import { StoreProviderError } from './store.types';
import {
  StoreAwsCredentialsSupplier,
  StoreAwsWifClient,
  storeAwsWifSettings,
} from './store-aws-wif';

@Injectable()
export class StoreAuth implements OnModuleDestroy {
  private googleClients = new Map<string, JWT>();
  private googleAdc = new Map<string, GoogleAuth>();
  private googleWif = new Map<string, StoreAwsWifClient>();
  private awsSupplier?: StoreAwsCredentialsSupplier;
  private appleToken?: { value: string; expires: number };
  constructor(private readonly config: StoreConfig) {}

  async google(scope: 'publisher' | 'reporting' | 'storage'): Promise<string> {
    const scopes = {
      publisher: 'androidpublisher',
      reporting: 'playdeveloperreporting',
      storage: 'devstorage.read_only',
    };
    try {
      const mode =
        this.config.value('STORE_GOOGLE_AUTH_MODE') || 'service_account';
      if (mode === 'aws_wif') {
        let client = this.googleWif.get(scope);
        if (!client) {
          const settings = storeAwsWifSettings((key) => this.config.value(key));
          this.awsSupplier ??= new StoreAwsCredentialsSupplier(settings.region);
          client = new StoreAwsWifClient({
            audience: settings.audience,
            subject_token_type: 'urn:ietf:params:aws:token-type:aws4_request',
            service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${settings.email}:generateAccessToken`,
            aws_security_credentials_supplier: this.awsSupplier,
            scopes: [`https://www.googleapis.com/auth/${scopes[scope]}`],
          });
          this.googleWif.set(scope, client);
        }
        const result = await client.getAccessToken();
        if (!result.token) throw new Error('NO_TOKEN');
        return result.token;
      }
      if (mode === 'adc') {
        let auth = this.googleAdc.get(scope);
        if (!auth) {
          auth = new GoogleAuth({
            scopes: [`https://www.googleapis.com/auth/${scopes[scope]}`],
            clientOptions: {
              transporterOptions: { timeout: 15000, retry: false },
            },
          });
          this.googleAdc.set(scope, auth);
        }
        const token = await auth.getAccessToken();
        if (!token) throw new Error('NO_TOKEN');
        return token;
      }
      if (mode !== 'service_account') throw new Error('INVALID_AUTH_MODE');
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
    } catch (error) {
      // Preserve only our fixed, non-sensitive setup diagnostics. Provider/SDK
      // errors can contain credentials and must still be replaced entirely.
      if (
        error instanceof StoreProviderError &&
        [
          'GOOGLE_WIF_CONFIGURATION_INVALID',
          'GOOGLE_WIF_TEMPORARY_AWS_CREDENTIALS_REQUIRED',
        ].includes(error.code)
      )
        throw new StoreProviderError(error.code);
      throw new StoreProviderError('GOOGLE_AUTH_FAILED');
    }
  }

  onModuleDestroy(): void {
    this.awsSupplier?.destroy();
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
