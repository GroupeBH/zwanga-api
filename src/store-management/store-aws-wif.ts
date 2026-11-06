import { STSClient } from '@aws-sdk/client-sts';
import {
  AwsClient,
  AwsClientOptions,
  AwsSecurityCredentials,
  AwsSecurityCredentialsSupplier,
} from 'google-auth-library';
import { StsCredentials } from 'google-auth-library/build/src/auth/stscredentials';
import { withDeadline } from '../common/utils/with-deadline';
import { StoreProviderError } from './store.types';

const TOKEN_URL = 'https://sts.googleapis.com/v1/token';
const HTTP_TIMEOUT_MS = 10_000;

export function storeAwsWifSettings(value: (key: string) => string): {
  audience: string;
  email: string;
  region: string;
} {
  const audience = value('STORE_GOOGLE_WIF_AUDIENCE');
  const email = value('STORE_GOOGLE_CLIENT_EMAIL');
  const region = value('AWS_REGION') || value('AWS_DEFAULT_REGION');
  // Only canonical Google resources, never caller-supplied URLs or credentials.
  if (
    !/^\/\/iam\.googleapis\.com\/projects\/[1-9][0-9]*\/locations\/global\/workloadIdentityPools\/[a-z][a-z0-9-]{3,31}\/providers\/[a-z][a-z0-9-]{3,31}$/.test(
      audience,
    ) ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(
      email,
    ) ||
    !/^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:central|east|west|north|south|northeast|northwest|southeast|southwest)-[1-9][0-9]*$/.test(
      region,
    )
  ) {
    throw new StoreProviderError('GOOGLE_WIF_CONFIGURATION_INVALID');
  }
  return { audience, email, region };
}

/** Uses the AWS SDK's cached, rotating credential chain, including ECS/Fargate. */
export class StoreAwsCredentialsSupplier implements AwsSecurityCredentialsSupplier {
  private readonly aws: STSClient;

  constructor(private readonly region: string) {
    this.aws = new STSClient({
      region,
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
    });
  }

  async getAwsRegion(): Promise<string> {
    return this.region;
  }

  async getAwsSecurityCredentials(): Promise<AwsSecurityCredentials> {
    // Bounds the caller; credential resolution itself is owned/cached by the SDK.
    // Do not snapshot credentials at startup: ECS rotates them automatically.
    const credentials = await withDeadline(
      () => this.aws.config.credentials(),
      5000,
    );
    if (
      !credentials.accessKeyId ||
      !credentials.secretAccessKey ||
      !credentials.sessionToken ||
      (credentials.expiration &&
        !(credentials.expiration.getTime() > Date.now() + 30_000))
    ) {
      throw new StoreProviderError(
        'GOOGLE_WIF_TEMPORARY_AWS_CREDENTIALS_REQUIRED',
      );
    }
    return {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      token: credentials.sessionToken,
    };
  }

  destroy(): void {
    this.aws.destroy();
  }
}

/** Keep Google's signing/exchange/cache logic; bound both HTTP exchange stages. */
export class StoreAwsWifClient extends AwsClient {
  constructor(options: AwsClientOptions) {
    super({ ...options, token_url: TOKEN_URL });
    // google-auth-library 10.x constructs STS with a separate unbounded transport.
    // This small compatibility bridge is covered by an end-to-end mocked exchange
    // test, to catch changes to this library-internal class when upgrading it.
    this.stsCredential = new StsCredentials({
      tokenExchangeEndpoint: TOKEN_URL,
      transporter: this.transporter,
    });
    this.transporter.interceptors.request.add({
      resolved: async (request) => {
        request.timeout = HTTP_TIMEOUT_MS;
        request.signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
        request.maxRedirects = 0;
        // The Store queue owns retries; do not multiply them inside auth.
        request.retry = false;
        return request;
      },
    });
  }
}
