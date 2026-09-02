import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { DiditKycService } from './didit-kyc.service';
import { KycProvider, KycStatus } from './entities/kyc-document.entity';
import { UserStatus } from './entities/user.entity';

const createConfigService = (values: Record<string, string | undefined>) => ({
  get: jest.fn((key: string) => values[key]),
});

const createFetchResponse = (payload: unknown, ok = true, status = 200) => ({
  ok,
  status,
  text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
});

const canonicalJson = (payload: unknown): string => {
  const sortValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(sortValue);
    }

    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
          const item = (value as Record<string, unknown>)[key];
          if (item !== undefined) {
            result[key] = sortValue(item);
          }
          return result;
        }, {});
    }

    return value;
  };

  return JSON.stringify(sortValue(payload));
};

describe('DiditKycService', () => {
  const baseConfig = {
    DIDIT_KYC_ENABLED: 'true',
    // A stale deployment value must never override the approved Didit origin.
    DIDIT_API_BASE_URL: 'https://api.didit.me',
    DIDIT_API_KEY: 'didit-api-key',
    DIDIT_WORKFLOW_ID: 'workflow-1',
    DIDIT_WEBHOOK_SECRET: 'webhook-secret',
  };

  let user: any;
  let kyc: any;
  let userRepository: any;
  let kycRepository: any;
  let txUserRepository: any;
  let txKycRepository: any;
  let dataSource: any;
  let service: DiditKycService;

  beforeEach(() => {
    user = {
      id: 'user-1',
      firstName: 'Eugene',
      lastName: 'Buania',
      phone: '+243000000000',
      email: null,
      status: UserStatus.PENDING_KYC,
    };
    kyc = {
      id: 'kyc-1',
      userId: user.id,
      status: KycStatus.PENDING,
      provider: KycProvider.DIDIT,
      diditSessionId: 'session-1',
      diditSessionNumber: null,
      diditWorkflowId: null,
      diditVendorData: null,
      diditSessionStatus: null,
      diditLastSyncedAt: null,
      providerMetadata: null,
      rejectionReason: null,
    };
    userRepository = {
      findOne: jest.fn().mockResolvedValue(user),
    };
    kycRepository = {
      findOne: jest.fn().mockResolvedValue(kyc),
      create: jest.fn((payload) => payload),
    };
    txUserRepository = {
      findOne: jest.fn().mockResolvedValue(user),
      save: jest.fn(async (payload) => payload),
    };
    txKycRepository = {
      findOne: jest.fn().mockResolvedValue(kyc),
      create: jest.fn((payload) => payload),
      save: jest.fn(async (payload) => payload),
    };
    dataSource = {
      transaction: jest.fn(async (callback) =>
        callback({
          getRepository: jest.fn((entity) => {
            if (entity.name === 'User') {
              return txUserRepository;
            }
            return txKycRepository;
          }),
        }),
      ),
    };
    service = new DiditKycService(
      userRepository,
      kycRepository,
      createConfigService(baseConfig) as any,
      dataSource,
    );
    jest.spyOn(global, 'fetch').mockResolvedValue(
      createFetchResponse({
        session_id: 'session-1',
        session_number: 42,
        url: 'https://verify.didit.test/session-1',
        status: 'Not Started',
        vendor_data: user.id,
        workflow_id: 'workflow-1',
      }) as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a hosted Didit session with the Zwanga user id as vendor_data', async () => {
    user.firstName = '  Eugène  ';
    user.lastName = 'Bosuku   Buania';
    const result = await service.createSession(user.id, {
      callbackUrl: 'zwanga://kyc/didit-return',
      language: 'fr',
      source: 'profile',
    });

    expect(result.sessionId).toBe('session-1');
    expect(result.url).toBe('https://verify.didit.test/session-1');
    const requestBody: unknown = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1].body,
    );
    expect(requestBody).toEqual(
      expect.objectContaining({
        expected_details: {
          first_name: 'Eugène',
          last_name: 'Bosuku Buania',
        },
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://verification.didit.me/v3/session/',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining(`"vendor_data":"${user.id}"`),
      }),
    );
    expect(txKycRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: KycProvider.DIDIT,
        diditSessionId: 'session-1',
        status: KycStatus.PENDING,
      }),
    );
  });

  it('creates a native SDK Didit session when Didit returns a session token without hosted URL', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      createFetchResponse({
        session_id: 'session-native-1',
        session_number: 43,
        session_token: 'didit-session-token',
        status: 'Not Started',
        vendor_data: user.id,
        workflow_id: 'workflow-1',
      }) as any,
    );

    const result = await service.createSession(user.id, {
      callbackUrl: 'zwanga://kyc/didit-return',
      language: 'fr',
      source: 'profile',
    });

    expect(result.sessionId).toBe('session-native-1');
    expect(result.sessionToken).toBe('didit-session-token');
    expect(result.session_token).toBe('didit-session-token');
    expect(result.url).toBe('');
  });

  it('approves local KYC only after a server-side Didit decision fetch', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      createFetchResponse({
        session_id: 'session-1',
        status: 'Approved',
        vendor_data: user.id,
        workflow_id: 'workflow-1',
      }) as any,
    );

    const result = await service.syncSession(user.id, {
      sessionId: 'session-1',
      status: 'Approved',
    });

    expect(result?.status).toBe(KycStatus.APPROVED);
    expect(user.status).toBe(UserStatus.ACTIVE);
    expect(txUserRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: UserStatus.ACTIVE }),
    );
  });

  it('keeps the local status unchanged when sync is called without Didit API configuration', async () => {
    service = new DiditKycService(
      userRepository,
      kycRepository,
      createConfigService({ DIDIT_KYC_ENABLED: 'false' }) as any,
      dataSource,
    );

    const result = await service.syncSession(user.id, {
      sessionId: 'session-1',
      status: 'Approved',
    });

    expect(result?.status).toBe(KycStatus.PENDING);
    expect(txUserRepository.save).not.toHaveBeenCalled();
  });

  it('returns an actionable reason when Didit detects a legal name mismatch', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      createFetchResponse({
        session_id: 'session-1',
        status: 'Declined',
        vendor_data: user.id,
        id_verifications: [
          {
            warnings: [{ risk: 'FULL_NAME_MISMATCH_WITH_PROVIDED' }],
          },
        ],
      }) as any,
    );

    const result = await service.syncSession(user.id, {
      sessionId: 'session-1',
      status: 'Declined',
    });

    expect(result?.status).toBe(KycStatus.REJECTED);
    expect(result?.rejectionReason).toContain(
      'Les noms du compte Zwanga ne correspondent pas',
    );
    expect(result?.providerMetadata).toEqual(
      expect.objectContaining({
        warningCodes: ['FULL_NAME_MISMATCH_WITH_PROVIDED'],
      }),
    );
  });

  it('rejects Didit webhooks with an invalid signature', async () => {
    await expect(
      service.handleWebhook(
        {
          'x-timestamp': `${Math.floor(Date.now() / 1000)}`,
          'x-signature-v2': 'invalid',
        },
        {
          session_id: 'session-1',
          status: 'Approved',
          vendor_data: user.id,
        },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a signed v2 webhook and applies the refreshed Didit decision', async () => {
    const payload = {
      session_id: 'session-1',
      status: 'Approved',
      vendor_data: user.id,
      workflow_id: 'workflow-1',
    };
    const signature = createHmac('sha256', baseConfig.DIDIT_WEBHOOK_SECRET!)
      .update(canonicalJson(payload))
      .digest('hex');

    (global.fetch as jest.Mock).mockResolvedValueOnce(
      createFetchResponse(payload) as any,
    );

    const result = await service.handleWebhook(
      {
        'x-timestamp': `${Math.floor(Date.now() / 1000)}`,
        'x-signature-v2': signature,
      },
      payload,
    );

    expect(result.status).toBe(KycStatus.APPROVED);
    expect(txKycRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: KycStatus.APPROVED,
        diditSessionId: 'session-1',
      }),
    );
  });
});
