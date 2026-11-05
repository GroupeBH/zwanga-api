import { ConfigService } from '@nestjs/config';
import { STSClient } from '@aws-sdk/client-sts';
import { AwsClient, GoogleAuth, JWT } from 'google-auth-library';
import { StoreAuth } from './store.auth';
import { StoreConfig } from './store.config';
import { StoreProviderError } from './store.types';
import {
  StoreAwsCredentialsSupplier,
  StoreAwsWifClient,
  storeAwsWifSettings,
} from './store-aws-wif';

jest.mock('@aws-sdk/client-sts', () => ({ STSClient: jest.fn() }));

const settings = {
  STORE_MANAGEMENT_ENABLED: 'true',
  STORE_GOOGLE_AUTH_MODE: 'aws_wif',
  STORE_GOOGLE_PACKAGE_NAME: 'com.zwanga',
  STORE_GOOGLE_WIF_AUDIENCE:
    '//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/zwanga-aws/providers/ecs-production',
  STORE_GOOGLE_CLIENT_EMAIL:
    'play-reader@sample-project.iam.gserviceaccount.com',
  AWS_REGION: 'eu-central-1',
  AWS_DEFAULT_REGION: '',
};
const temporaryCredentials = () => ({
  accessKeyId: 'synthetic-access-key',
  secretAccessKey: 'synthetic-secret-key',
  sessionToken: 'synthetic-session-token',
  expiration: new Date(Date.now() + 3600_000),
});
const configFor = (overrides: Record<string, string> = {}) =>
  new StoreConfig(new ConfigService({ ...settings, ...overrides }));

describe('Google AWS federation (no external requests or real credentials)', () => {
  const credentials = jest.fn();
  const destroy = jest.fn();
  beforeEach(() => {
    credentials
      .mockReset()
      .mockImplementation(async () => temporaryCredentials());
    destroy.mockReset();
    (STSClient as unknown as jest.Mock).mockReset().mockImplementation(() => ({
      config: { credentials },
      destroy,
    }));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('needs only public Google settings and a region, not a private key or ADC file', () => {
    const config = configFor();
    expect(config.missing('google')).toEqual([]);
    expect(config.assertReady('google')).toBe('com.zwanga');
    expect(
      configFor({ STORE_GOOGLE_WIF_AUDIENCE: '', AWS_REGION: '' }).missing(
        'google',
      ),
    ).toEqual(['STORE_GOOGLE_WIF_AUDIENCE', 'AWS_REGION']);
    expect(
      configFor({
        AWS_REGION: '',
        AWS_DEFAULT_REGION: 'eu-central-1',
      }).assertReady('google'),
    ).toBe('com.zwanga');
    expect(STSClient).not.toHaveBeenCalled();
  });

  it.each([
    [
      'STORE_GOOGLE_WIF_AUDIENCE',
      '//iam.googleapis.com/projects/project-name/locations/global/workloadIdentityPools/zwanga/providers/aws-prod',
    ],
    ['STORE_GOOGLE_WIF_AUDIENCE', 'https://attacker.invalid/token'],
    [
      'STORE_GOOGLE_WIF_AUDIENCE',
      settings.STORE_GOOGLE_WIF_AUDIENCE + '?redirect=evil',
    ],
    ['STORE_GOOGLE_CLIENT_EMAIL', 'user@example.com'],
    [
      'STORE_GOOGLE_CLIENT_EMAIL',
      'play-reader@sample-project.iam.gserviceaccount.com/../../evil',
    ],
    ['AWS_REGION', 'eu-central-1.attacker.invalid/'],
  ])('rejects malformed %s before accessing credentials', (key, value) => {
    expect(() => configFor({ [key]: value }).assertReady('google')).toThrow(
      'GOOGLE_WIF_CONFIGURATION_INVALID',
    );
    expect(STSClient).not.toHaveBeenCalled();
  });

  it('uses refreshed ECS credentials, shares the SDK provider, and destroys its resources', async () => {
    const supplier = new StoreAwsCredentialsSupplier('eu-central-1');
    expect(credentials).not.toHaveBeenCalled();
    expect(await supplier.getAwsRegion()).toBe('eu-central-1');
    expect(await supplier.getAwsSecurityCredentials()).toEqual({
      accessKeyId: 'synthetic-access-key',
      secretAccessKey: 'synthetic-secret-key',
      token: 'synthetic-session-token',
    });
    credentials.mockResolvedValueOnce({
      ...temporaryCredentials(),
      sessionToken: 'rotated-token',
    });
    expect((await supplier.getAwsSecurityCredentials()).token).toBe(
      'rotated-token',
    );
    expect(STSClient).toHaveBeenCalledTimes(1);
    supplier.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    'GOOGLE_WIF_CONFIGURATION_INVALID',
    'GOOGLE_WIF_TEMPORARY_AWS_CREDENTIALS_REQUIRED',
  ])(
    'preserves safe setup code %s without extra SDK error details',
    async (code) => {
      const error = new StoreProviderError(code);
      Object.assign(error, { request: { authorization: 'synthetic-secret' } });
      jest
        .spyOn(StoreAwsWifClient.prototype, 'getAccessToken')
        .mockRejectedValue(error);
      const auth = new StoreAuth(configFor());
      try {
        await expect(auth.google('publisher')).rejects.toEqual(
          new StoreProviderError(code),
        );
        await auth.google('publisher').catch((failure) => {
          expect(failure).not.toBe(error);
          expect(JSON.stringify(failure)).not.toContain('synthetic-secret');
        });
      } finally {
        auth.onModuleDestroy();
      }
    },
  );

  it('does not expose unrecognized provider errors as setup diagnostics', async () => {
    jest
      .spyOn(StoreAwsWifClient.prototype, 'getAccessToken')
      .mockRejectedValue(
        new StoreProviderError('provider-body-containing-sensitive-details'),
      );
    const auth = new StoreAuth(configFor());
    try {
      await expect(auth.google('publisher')).rejects.toEqual(
        new StoreProviderError('GOOGLE_AUTH_FAILED'),
      );
    } finally {
      auth.onModuleDestroy();
    }
  });

  it.each(['permanent', 'expired', 'expiring'])(
    'rejects %s AWS credentials',
    async (kind) => {
      const invalid = temporaryCredentials();
      if (kind === 'permanent') invalid.sessionToken = '';
      else
        invalid.expiration = new Date(
          Date.now() + (kind === 'expired' ? -1000 : 10_000),
        );
      credentials.mockResolvedValue(invalid);
      await expect(
        new StoreAwsCredentialsSupplier(
          'eu-central-1',
        ).getAwsSecurityCredentials(),
      ).rejects.toThrow('GOOGLE_WIF_TEMPORARY_AWS_CREDENTIALS_REQUIRED');
    },
  );

  it('bounds caller latency when the AWS credential provider stalls', async () => {
    jest.useFakeTimers();
    credentials.mockReturnValue(new Promise(() => undefined));
    const result = new StoreAwsCredentialsSupplier(
      'eu-central-1',
    ).getAwsSecurityCredentials();
    const rejected = expect(result).rejects.toThrow(
      'Operation deadline exceeded',
    );
    await jest.advanceTimersByTimeAsync(5000);
    await rejected;
  });

  it('exchanges a signed AWS identity then impersonates with a bounded transport, caches and refreshes Google tokens', async () => {
    const { audience, email } = storeAwsWifSettings((key) =>
      configFor().value(key),
    );
    const supplier = new StoreAwsCredentialsSupplier('eu-central-1');
    const client = new StoreAwsWifClient({
      audience,
      subject_token_type: 'urn:ietf:params:aws:token-type:aws4_request',
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${email}:generateAccessToken`,
      aws_security_credentials_supplier: supplier,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    let grants = 0;
    const adapter = jest.fn(async (options) => {
      expect(options.timeout).toBe(10_000);
      expect(options.maxRedirects).toBe(0);
      expect(options.retry).toBe(false);
      expect(options.signal).toBeDefined();
      const isSts =
        options.url.toString() === 'https://sts.googleapis.com/v1/token';
      if (isSts) {
        const body = new URLSearchParams(options.body);
        expect(body.get('audience')).toBe(audience);
        const signed = JSON.parse(
          decodeURIComponent(body.get('subject_token')!),
        );
        expect(signed.url).toBe(
          'https://sts.eu-central-1.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15',
        );
        expect(signed.headers).toContainEqual({
          key: 'x-amz-security-token',
          value: 'synthetic-session-token',
        });
        expect(signed.headers).toContainEqual({
          key: 'x-goog-cloud-target-resource',
          value: audience,
        });
      } else {
        expect(options.url.toString()).toBe(
          `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${email}:generateAccessToken`,
        );
        expect(JSON.parse(options.body)).toEqual({
          scope: ['https://www.googleapis.com/auth/androidpublisher'],
          lifetime: '3600s',
        });
      }
      return {
        config: options,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        data: isSts
          ? {
              access_token: 'synthetic-federated',
              expires_in: 3600,
              token_type: 'Bearer',
            }
          : {
              accessToken: `synthetic-google-${++grants}`,
              expireTime: new Date(Date.now() + 3600_000).toISOString(),
            },
      };
    });
    client.transporter.defaults.adapter = adapter;
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => client.getAccessToken()),
    );
    expect(concurrent.map((result) => result.token)).toEqual(
      Array(5).fill('synthetic-google-1'),
    );
    expect(adapter).toHaveBeenCalledTimes(2);
    expect((await client.getAccessToken()).token).toBe('synthetic-google-1');
    expect(adapter).toHaveBeenCalledTimes(2);
    const later = Date.now() + 3700_000;
    // Google uses new Date().getTime(), so fake only the clock, not HTTP timers.
    jest.useFakeTimers({
      now: later,
      doNotFake: ['setTimeout', 'clearTimeout'],
    });
    expect((await client.getAccessToken()).token).toBe('synthetic-google-2');
    expect(adapter).toHaveBeenCalledTimes(4);
    expect(credentials).toHaveBeenCalledTimes(2);
  });

  it.each(['sts', 'impersonation'])(
    'aborts a stalled %s exchange and allows a subsequent retry',
    async (stage) => {
      jest.useFakeTimers();
      jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('bounded timeout')), ms);
        return controller.signal;
      });
      const { audience, email } = storeAwsWifSettings((key) =>
        configFor().value(key),
      );
      const client = new StoreAwsWifClient({
        audience,
        subject_token_type: 'urn:ietf:params:aws:token-type:aws4_request',
        service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${email}:generateAccessToken`,
        aws_security_credentials_supplier: new StoreAwsCredentialsSupplier(
          'eu-central-1',
        ),
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
      });
      let stall = true;
      const adapter = jest.fn(async (options) => {
        const isSts = options.url.hostname === 'sts.googleapis.com';
        if (stall && (stage === 'sts' ? isSts : !isSts)) {
          return new Promise<never>((_, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(options.signal.reason),
              { once: true },
            );
          });
        }
        return {
          config: options,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          data: isSts
            ? {
                access_token: 'synthetic-federated',
                expires_in: 3600,
                token_type: 'Bearer',
              }
            : {
                accessToken: 'recovered-token',
                expireTime: new Date(Date.now() + 3600_000).toISOString(),
              },
        };
      });
      client.transporter.defaults.adapter = adapter;
      const result = client.getAccessToken();
      const rejected = expect(result).rejects.toThrow('bounded timeout');
      await jest.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(adapter).toHaveBeenCalledTimes(stage === 'sts' ? 1 : 2);
      stall = false;
      expect((await client.getAccessToken()).token).toBe('recovered-token');
    },
  );

  it('keeps distinct scope clients, reuses the AWS supplier, and sanitizes failures without JWT/ADC fallback', async () => {
    const seen: AwsClient[] = [];
    const token = jest
      .spyOn(StoreAwsWifClient.prototype, 'getAccessToken')
      .mockImplementation(async function () {
        seen.push(this);
        return { token: 'synthetic-google-token' };
      });
    const jwt = jest
      .spyOn(JWT.prototype, 'getAccessToken')
      .mockRejectedValue(new Error('unexpected JWT'));
    const adc = jest
      .spyOn(GoogleAuth.prototype, 'getAccessToken')
      .mockRejectedValue(new Error('unexpected ADC'));
    const auth = new StoreAuth(configFor());
    for (const scope of [
      'publisher',
      'publisher',
      'reporting',
      'storage',
    ] as const)
      expect(await auth.google(scope)).toBe('synthetic-google-token');
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).not.toBe(seen[2]);
    expect(seen.map((client) => client.scopes)).toEqual([
      ['https://www.googleapis.com/auth/androidpublisher'],
      ['https://www.googleapis.com/auth/androidpublisher'],
      ['https://www.googleapis.com/auth/playdeveloperreporting'],
      ['https://www.googleapis.com/auth/devstorage.read_only'],
    ]);
    expect(STSClient).toHaveBeenCalledTimes(1);
    token.mockRejectedValueOnce(
      Object.assign(new Error('sensitive credentials'), {
        config: { token: 'private-value' },
      }),
    );
    await expect(auth.google('publisher')).rejects.toMatchObject({
      message: 'GOOGLE_AUTH_FAILED',
    });
    token.mockResolvedValueOnce({ token: null });
    await expect(auth.google('publisher')).rejects.toThrow(
      'GOOGLE_AUTH_FAILED',
    );
    expect(jwt).not.toHaveBeenCalled();
    expect(adc).not.toHaveBeenCalled();
    auth.onModuleDestroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('fails closed for an unknown auth mode but preserves legacy service-account configuration', async () => {
    const config = configFor({
      STORE_GOOGLE_AUTH_MODE: 'aws-wfi',
      STORE_GOOGLE_PRIVATE_KEY: 'unused',
    });
    expect(() => config.assertReady('google')).toThrow(
      'Mode d’authentification Google invalide.',
    );
    await expect(new StoreAuth(config).google('publisher')).rejects.toThrow(
      'GOOGLE_AUTH_FAILED',
    );
    const legacy = configFor({
      STORE_GOOGLE_AUTH_MODE: '',
      STORE_GOOGLE_PRIVATE_KEY: 'mock-only',
    });
    expect(legacy.assertReady('google')).toBe('com.zwanga');
    const jwt = jest
      .spyOn(JWT.prototype, 'getAccessToken')
      .mockResolvedValue({ token: 'legacy-token' });
    expect(await new StoreAuth(legacy).google('publisher')).toBe(
      'legacy-token',
    );
    expect(jwt).toHaveBeenCalledTimes(1);
    expect(STSClient).not.toHaveBeenCalled();
  });
});
