import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { DiditKycService } from './didit-kyc.service';
import { KycProvider, KycStatus } from './entities/kyc-document.entity';
import { UserRole, UserStatus } from './entities/user.entity';

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
  let txVehicleRepository: any;
  let dataSource: any;
  let service: DiditKycService;
  let evidence: { enqueue: jest.Mock };

  beforeEach(() => {
    user = {
      id: 'user-1',
      firstName: 'Eugene',
      lastName: 'Buania',
      phone: '+243000000000',
      email: null,
      status: UserStatus.PENDING_KYC,
      role: UserRole.PASSENGER,
      isDriver: false,
      isActive: true,
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
      update: jest.fn(async (_id, patch) => Object.assign(user, patch)),
    };
    txKycRepository = {
      findOne: jest.fn().mockResolvedValue(kyc),
      create: jest.fn((payload) => payload),
      save: jest.fn(async (payload) => payload),
    };
    txVehicleRepository = {
      exists: jest.fn().mockResolvedValue(false),
    };
    dataSource = {
      transaction: jest.fn(async (callback) =>
        callback({
          getRepository: jest.fn((entity) => {
            if (entity.name === 'User') {
              return txUserRepository;
            }
            if (entity.name === 'Vehicle') {
              return txVehicleRepository;
            }
            return txKycRepository;
          }),
        }),
      ),
    };
    evidence = { enqueue: jest.fn().mockResolvedValue(undefined) };
    service = new DiditKycService(
      userRepository,
      kycRepository,
      createConfigService(baseConfig) as any,
      dataSource,
      evidence as any,
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

  it('does not let a late Didit decision overwrite a newer AWS dossier', async () => {
    const aws = { ...kyc, provider: KycProvider.AWS, diditSessionId: null };
    txKycRepository.findOne.mockResolvedValue(aws);
    const saved = await (service as any).applyDiditState({ userId: user.id,
      payload: { session_id: 'old-didit', status: 'Approved', vendor_data: user.id }, source: 'webhook' });
    expect(saved).toBe(aws);
    expect(txKycRepository.save).not.toHaveBeenCalled();
    expect(txUserRepository.update).not.toHaveBeenCalled();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('blocks new Didit sessions after AWS cutover even with the old Didit flag and key present', async () => {
    const awsService = new DiditKycService(userRepository, kycRepository,
      createConfigService({ ...baseConfig, KYC_PROVIDER: 'aws' }) as any, dataSource, evidence as any);
    await expect(awsService.createSession(user.id, {})).rejects.toMatchObject({
      response: { code: 'KYC_APP_UPDATE_REQUIRED', message: expect.stringContaining('Mettez à jour Zwanga') },
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it.each(['true', 'false', undefined])('still synchronizes historical Didit after cutover with the old flag %s', async (enabled) => {
    const awsService = new DiditKycService(userRepository, kycRepository,
      createConfigService({ ...baseConfig, KYC_PROVIDER: 'aws', DIDIT_KYC_ENABLED: enabled }) as any, dataSource, evidence as any);
    await awsService.syncSession(user.id, { sessionId: 'session-1' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://verification.didit.me/v3/session/session-1/decision/', expect.objectContaining({ method: 'GET' }));
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

  it('uses the hosted flow for old mobile builds when the operational override is enabled', async () => {
    service = new DiditKycService(userRepository, kycRepository,
      createConfigService({ ...baseConfig, DIDIT_KYC_LAUNCH_MODE: 'hosted' }) as any, dataSource);
    (global.fetch as jest.Mock).mockResolvedValueOnce(createFetchResponse({
      session_id: 'session-web', session_token: 'private-test-token',
      url: 'https://verify.didit.me/session/test-session', status: 'Not Started',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    }) as any);
    const result = await service.createSession(user.id, {
      language: 'fr', callbackUrl: 'zwanga://kyc/didit-return',
    });
    expect(result.sessionId).toBe('session-web');
    expect(result.session_id).toBe(result.sessionId);
    expect(result.sessionToken).toBeNull();
    expect(result.session_token).toBeNull();
    expect(result.url).toBe('https://verify.didit.me/session/test-session');
    expect(result.verification_url).toBe(result.url);
    expect(result.expiresAt).toBe(result.expires_at);
    expect(JSON.stringify(result)).not.toContain('private-test-token');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual(
      expect.objectContaining({ callback: 'zwanga://kyc/didit-return' }),
    );
    expect(txKycRepository.save).toHaveBeenCalledWith(expect.objectContaining({ status: KycStatus.PENDING }));
  });

  it.each([undefined, 'https://other.example/session/test', 'http://verify.didit.me/session/test'])
  ('never falls back to the broken native SDK or a second session when hosted URL is unusable (%s)', async (url) => {
    service = new DiditKycService(userRepository, kycRepository,
      createConfigService({ ...baseConfig, DIDIT_KYC_LAUNCH_MODE: 'hosted' }) as any, dataSource);
    (global.fetch as jest.Mock).mockResolvedValueOnce(createFetchResponse({
      session_id: 'session-web', session_token: 'private-test-token', url, status: 'Not Started',
    }) as any);

    await expect(service.createSession(user.id, {})).rejects.toMatchObject({
      response: { code: 'KYC_HOSTED_URL_UNAVAILABLE' },
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(txKycRepository.save).not.toHaveBeenCalled();
    expect(txUserRepository.update).not.toHaveBeenCalled();
  });

  it('does not trust an Approved browser callback while Didit still reports a pending hosted session', async () => {
    service = new DiditKycService(userRepository, kycRepository,
      createConfigService({ ...baseConfig, DIDIT_KYC_LAUNCH_MODE: 'hosted' }) as any, dataSource);
    (global.fetch as jest.Mock).mockResolvedValueOnce(createFetchResponse({
      session_id: 'session-1', status: 'In Review', vendor_data: user.id,
    }) as any);

    const result = await service.syncSession(user.id, { sessionId: 'session-1', status: 'Approved' });

    expect(result?.status).toBe(KycStatus.PENDING);
    expect(user.status).toBe(UserStatus.PENDING_KYC);
    expect(txUserRepository.update).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock).mock.calls[0][1].method).toBe('GET');
  });

  it('rejects an invalid launch mode before calling Didit', async () => {
    service = new DiditKycService(userRepository, kycRepository,
      createConfigService({ ...baseConfig, DIDIT_KYC_LAUNCH_MODE: 'invalid' }) as any, dataSource);
    await expect(service.createSession(user.id, {})).rejects.toMatchObject({
      response: { code: 'KYC_LAUNCH_MODE_INVALID' },
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(txKycRepository.save).not.toHaveBeenCalled();
  });

  it.each(['native', 'hosted'])
  ('keeps the configured workflow and uses only the session API in %s mode', async (mode) => {
    service = new DiditKycService(userRepository, kycRepository,
      createConfigService({ ...baseConfig, DIDIT_KYC_LAUNCH_MODE: mode }) as any, dataSource);
    (global.fetch as jest.Mock).mockImplementation(async (url, options) => {
      // A session-capable key must not also require workflow-management access.
      if (url !== 'https://verification.didit.me/v3/session/' || options.method !== 'POST') {
        throw new Error('Unexpected workflow management request');
      }
      return createFetchResponse({
        session_id: 'session-compatible', session_token: 'test-token',
        url: 'https://verify.didit.me/fr/session/test-token', status: 'Not Started',
      });
    });

    const result = await service.createSession(user.id, {});

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toMatchObject({
      workflow_id: baseConfig.DIDIT_WORKFLOW_ID, vendor_data: user.id,
    });
    expect(result.workflowId).toBe(baseConfig.DIDIT_WORKFLOW_ID);
    expect(result.workflow_id).toBe(baseConfig.DIDIT_WORKFLOW_ID);
    expect(result.sessionToken).toBe(mode === 'hosted' ? null : 'test-token');
    expect(result.session_token).toBe(result.sessionToken);
    expect(result.url).toBe('https://verify.didit.me/fr/session/test-token');
    expect(txKycRepository.save).toHaveBeenCalledWith(expect.objectContaining({ status: KycStatus.PENDING }));
  });

  it.each([
    [400, 'KYC_PROVIDER_REJECTED_REQUEST'],
    [403, 'KYC_PROVIDER_AUTHENTICATION_FAILED'],
    [503, 'KYC_PROVIDER_UNAVAILABLE'],
  ])('still refuses a session rejected by Didit (%s) without changing the workflow', async (status, code) => {
    service = new DiditKycService(userRepository, kycRepository,
      createConfigService({ ...baseConfig, DIDIT_KYC_LAUNCH_MODE: 'hosted' }) as any, dataSource);
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      createFetchResponse({ detail: 'Workflow unavailable' }, false, Number(status)),
    );

    await expect(service.createSession(user.id, {})).rejects.toMatchObject({ response: { code } });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock).mock.calls[0][1].method).toBe('POST');
    expect(txKycRepository.save).not.toHaveBeenCalled();
    expect(txUserRepository.update).not.toHaveBeenCalled();
  });

  it('does not persist or approve an unusable provider session', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(createFetchResponse({
      session_id: 'expired', url: 'https://verify.didit.me/session/test', status: 'Expired',
    }) as any);
    await expect(service.createSession(user.id, {})).rejects.toMatchObject({
      response: { code: 'KYC_PROVIDER_UNUSABLE_SESSION' },
    });
    expect(txKycRepository.save).not.toHaveBeenCalled();
    expect(txUserRepository.update).not.toHaveBeenCalled();
  });

  it('returns a stable service-unavailable error when Didit cannot be reached', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(
      new TypeError('fetch failed'),
    );

    await expect(
      service.createSession(user.id, {
        callbackUrl: 'zwanga://kyc/didit-return',
        language: 'fr',
        source: 'profile',
      }),
    ).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({
        code: 'KYC_PROVIDER_UNAVAILABLE',
      }),
    });
  });

  it('returns a stable timeout error when Didit takes too long', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';
    (global.fetch as jest.Mock).mockRejectedValueOnce(timeoutError);

    await expect(
      service.createSession(user.id, {
        callbackUrl: 'zwanga://kyc/didit-return',
        language: 'fr',
        source: 'profile',
      }),
    ).rejects.toMatchObject({
      status: 504,
      response: expect.objectContaining({
        code: 'KYC_PROVIDER_TIMEOUT',
      }),
    });
  });

  it('reports missing Didit configuration as a server availability issue', async () => {
    service = new DiditKycService(
      userRepository,
      kycRepository,
      createConfigService({ DIDIT_KYC_ENABLED: 'false' }) as any,
      dataSource,
    );

    await expect(
      service.createSession(user.id, {
        callbackUrl: 'zwanga://kyc/didit-return',
        language: 'fr',
        source: 'profile',
      }),
    ).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({
        code: 'KYC_PROVIDER_NOT_CONFIGURED',
      }),
    });
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
    expect(result?.reviewedAt).toBeInstanceOf(Date);
    expect(result?.reviewedBy).toBeNull();
    expect(user.status).toBe(UserStatus.ACTIVE);
    expect(txUserRepository.update).toHaveBeenCalledWith(user.id,
      expect.objectContaining({ status: UserStatus.ACTIVE }),
    );
  });

  it('keeps the decision date stable on repeated approvals, including an admin-confirmed approval', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(createFetchResponse({
      session_id: 'session-1', status: 'Approved', vendor_data: user.id,
    }));
    await service.syncSession(user.id, { sessionId: 'session-1' });
    const reviewedAt = kyc.reviewedAt;
    kyc.reviewedBy = 'admin-1';
    await service.syncSession(user.id, { sessionId: 'session-1' });
    expect(kyc.reviewedAt).toBe(reviewedAt);
    expect(kyc.reviewedBy).toBe('admin-1');
  });

  it('versions a new Didit approval and clears attribution to an older admin rejection', async () => {
    const previousDate = new Date(Date.now() + 1_000);
    Object.assign(kyc, { status: KycStatus.REJECTED, reviewedAt: previousDate, reviewedBy: 'admin-1' });
    (global.fetch as jest.Mock).mockResolvedValue(createFetchResponse({
      session_id: 'session-1', status: 'Approved', vendor_data: user.id,
    }));
    await service.syncSession(user.id, { sessionId: 'session-1' });
    expect(kyc.reviewedAt.getTime()).toBeGreaterThan(previousDate.getTime());
    expect(kyc.reviewedBy).toBeNull();
  });

  it('activates only an explicitly requested driver profile after approval', async () => {
    user.driverOnboardingRequestedAt = new Date();
    user.role = UserRole.PASSENGER;
    user.isDriver = false;
    txVehicleRepository.exists.mockResolvedValue(true);

    (global.fetch as jest.Mock).mockResolvedValueOnce(
      createFetchResponse({
        session_id: 'session-1',
        status: 'Approved',
        vendor_data: user.id,
        workflow_id: 'workflow-1',
      }) as any,
    );

    await service.syncSession(user.id, {
      sessionId: 'session-1',
      status: 'Approved',
    });

    expect(user.role).toBe(UserRole.DRIVER);
    expect(user.isDriver).toBe(true);
    expect(txUserRepository.update).toHaveBeenCalledWith(user.id,
      expect.objectContaining({
        role: UserRole.DRIVER,
        isDriver: true,
        driverActivatedAt: expect.any(Date),
      }),
    );
  });

  it('never promotes a pending identity even when an active vehicle exists', async () => {
    user.role = UserRole.PASSENGER;
    user.isDriver = false;
    txVehicleRepository.exists.mockResolvedValue(true);

    (global.fetch as jest.Mock).mockResolvedValueOnce(
      createFetchResponse({
        session_id: 'session-1',
        status: 'Not Started',
        vendor_data: user.id,
        workflow_id: 'workflow-1',
      }) as any,
    );

    await service.syncSession(user.id, {
      sessionId: 'session-1',
      status: 'Not Started',
    });

    expect(user.role).toBe(UserRole.PASSENGER);
    expect(user.isDriver).toBe(false);
    expect(user.status).toBe(UserStatus.PENDING_KYC);
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
    expect(txUserRepository.update).not.toHaveBeenCalled();
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
    expect(evidence.enqueue).not.toHaveBeenCalled();
  });

  it('accepts a signed v2 manual-review webhook and applies the refreshed Didit decision', async () => {
    const payload = {
      webhook_type: 'status.updated',
      trigger: 'manual_review',
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
    expect(evidence.enqueue).toHaveBeenCalledWith(expect.objectContaining({getRepository:expect.any(Function)}),
      expect.objectContaining({id:kyc.id,userId:user.id,status:KycStatus.APPROVED,diditSessionId:'session-1'}));
    expect(txKycRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: KycStatus.APPROVED,
        diditSessionId: 'session-1',
      }),
    );
  });
});
