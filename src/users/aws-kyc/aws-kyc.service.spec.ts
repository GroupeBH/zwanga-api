import { ConfigService } from '@nestjs/config';
import { AwsKycService } from './aws-kyc.service';
import { AwsKycSession } from './aws-kyc-session.entity';

describe('AWS KYC server-owned verification', () => {
  it('capabilities reports disabled or incomplete configuration without provider calls', () => {
    for (const [configuration, unavailableCode] of [
      [{}, 'AWS_KYC_DISABLED'],
      [{ AWS_KYC_ENABLED: 'true' }, 'AWS_KYC_CONFIGURATION_REQUIRED'],
    ] as const) {
      const service = new AwsKycService(new ConfigService(configuration), {} as any, {} as any, {} as any);
      expect(service.capabilities()).toEqual(expect.objectContaining({ enabled: false, unavailableCode }));
    }
  });
  const fixture = () => {
    const repository = {
      owned: jest.fn().mockResolvedValue({}),
      transition: jest.fn(),
      retry: jest.fn(),
      snapshotKey: jest.fn().mockResolvedValue('new-key'),
    };
    const transport = { result: jest.fn(), compare: jest.fn(), ocr: jest.fn() };
    const storage = {
      read: jest.fn().mockResolvedValue({
        version: 1,
        sessionId: 'id',
        details: {},
        files: [
          { kind: 'document_front', data: 'YWJj' },
          { kind: 'selfie', data: 'ZGVm' },
        ],
        missing: [],
      }),
      write: jest.fn(),
    };
    const service = new AwsKycService(
      new ConfigService({
        AWS_KYC_ENABLED: 'true',
        AWS_S3_BUCKET_NAME: 'private',
        AWS_KYC_LIVENESS_ROLE_ARN: 'arn:aws:iam::123456789012:role/kyc',
      }),
      repository as any,
      transport as any,
      storage as any,
    );
    const row = {
      id: 'id',
      userId: 'user',
      state: 'liveness',
      livenessId: 'aws-session',
      region: 'eu-west-1',
      expiresAt: new Date(Date.now() + 60_000),
      checks: {},
      objectKey: 'old-key',
      failures: 0,
      runs: 1,
    } as unknown as AwsKycSession;
    return { repository, transport, storage, service, row };
  };
  it.each([
    { Status: 'FAILED', Confidence: 100 },
    { Status: 'SUCCEEDED', Confidence: 40 },
    {
      Status: 'SUCCEEDED',
      Confidence: 99,
      Challenge: { Type: 'FaceMovementChallenge' },
    },
    {
      Status: 'SUCCEEDED',
      Confidence: 99,
      Challenge: { Type: 'FaceMovementAndLightChallenge' },
    },
  ])('fails closed on invalid or incomplete AWS proof %j', async (response) => {
    const f = fixture();
    f.transport.result.mockResolvedValue({
      SessionId: f.row.livenessId,
      ...response,
    });
    await f.service.process(f.row);
    expect(f.repository.transition).toHaveBeenCalledWith(
      f.row,
      'failed',
      { liveness: 'failed' },
      'old-key',
      'LIVENESS_FAILED',
    );
    expect(f.transport.compare).not.toHaveBeenCalled();
  });
  it('does not trust a result from a different session', async () => {
    const f = fixture();
    f.transport.result.mockResolvedValue({ SessionId: 'other' });
    await f.service.process(f.row);
    expect(f.repository.retry).toHaveBeenCalled();
    expect(f.repository.transition).not.toHaveBeenCalled();
  });
  it('keeps pending capture pending and does not spend on face comparison', async () => {
    const f = fixture();
    f.transport.result.mockResolvedValue({
      SessionId: f.row.livenessId,
      Status: 'IN_PROGRESS',
    });
    await f.service.process(f.row);
    expect(f.repository.transition).toHaveBeenCalledWith(f.row, 'liveness');
    expect(f.transport.compare).not.toHaveBeenCalled();
  });
  it('compares only the uploaded document to the AWS reference frame and persists the decision inputs', async () => {
    const f = fixture();
    f.row.state = 'compare';
    f.row.checks = { liveness: 'passed' };
    f.transport.compare.mockResolvedValue({ passed: true, similarity: 99 });
    await f.service.process(f.row);
    expect(f.transport.compare).toHaveBeenCalledWith(
      'eu-west-1',
      Buffer.from('abc'),
      Buffer.from('def'),
      95,
    );
    expect(f.repository.transition).toHaveBeenCalledWith(
      f.row,
      'review',
      { liveness: 'passed', face: 'passed' },
      'new-key',
      null,
    );
  });
  it('routes an uncertain face comparison to manual review instead of automatically rejecting', async () => {
    const f = fixture();
    f.row.state = 'compare';
    f.row.checks = { liveness: 'passed' };
    f.transport.compare.mockResolvedValue({
      passed: false,
      similarity: 92,
      reason: 'FACE_MISMATCH',
    });
    await f.service.process(f.row);
    expect(f.repository.transition).toHaveBeenCalledWith(
      f.row,
      'review',
      { liveness: 'passed', face: 'review' },
      'new-key',
      'FACE_MISMATCH',
    );
  });
  it('bounds paid retries even after repeated worker crashes', async () => {
    const f = fixture();
    f.row.state = 'documents';
    f.row.runs = 4;
    await f.service.process(f.row);
    expect(f.storage.read).not.toHaveBeenCalled();
    expect(f.transport.ocr).not.toHaveBeenCalled();
    expect(f.repository.transition).toHaveBeenCalledWith(
      f.row,
      'failed',
      {},
      'old-key',
      'SERVICE_UNAVAILABLE',
    );
  });
  it('does not process another/deactivated owner or stale credentials', async () => {
    const f = fixture();
    f.repository.owned.mockRejectedValue(new Error('unavailable'));
    await f.service.process(f.row);
    expect(f.storage.read).not.toHaveBeenCalled();
  });
});
