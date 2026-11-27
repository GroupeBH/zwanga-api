import { Readable } from 'stream';
import { DiditFullCollector } from './didit-full-collector';
import {
  archiveProviderData,
  ownedDecision,
  providerFingerprint,
} from './didit-archive.policy';

describe('full Didit collection, independent of KYC verdicts', () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const exportId = '22222222-2222-4222-8222-222222222222';
  let api: any, storage: any, repo: any, collector: DiditFullCollector;
  const row = () =>
    ({
      id: 'archive',
      sessionId,
      userId: 'user',
      revision: 1,
      attempts: 1,
      expiresAt: new Date(Date.now() + 86400000),
      objectKeys: ['lease.json'],
    }) as any;
  const config = { apiKey: 'synthetic', hosts: ['media.didit.test'] } as any;
  beforeEach(() => {
    api = {
      decision: jest.fn(async (_id, _key, expanded) => ({
        session_id: sessionId,
        vendor_data: 'user',
        status: 'Approved',
        nfc_verifications: [{ chip: 'synthetic' }],
        aml_screenings: [{ score: 2 }],
        ...(expanded
          ? {
              events: [{ event: 'review' }],
              resubmissions: [{ status: 'Declined' }],
            }
          : { features: { email: true } }),
      })),
      user: jest
        .fn()
        .mockResolvedValue({
          vendor_data: 'user',
          comments: ['synthetic'],
          metadata: { custom: 'field' },
        }),
      report: jest.fn().mockResolvedValue(Buffer.from('%PDF-synthetic')),
      startExport: jest
        .fn()
        .mockResolvedValue({
          session_id: sessionId,
          export_id: exportId,
          status: 'PENDING',
        }),
      exportStatus: jest
        .fn()
        .mockResolvedValue({
          session_id: sessionId,
          export_id: exportId,
          status: 'READY',
          download_url: 'https://media.didit.test/file.zip?signature=secret',
          size_bytes: 4,
        }),
      originals: jest.fn(async () =>
        Readable.from([Buffer.from('PK\x05\x06')]),
      ),
    };
    storage = {
      writeAttachment: jest.fn(async (_key, kind, _bytes, size) => ({
        kind,
        size,
      })),
      writeImages: jest.fn(),
    };
    repo = { saveExport: jest.fn().mockResolvedValue(true), finish: jest.fn() };
    collector = new DiditFullCollector(
      api,
      { image: jest.fn() } as any,
      storage,
      repo,
    );
  });
  const provider = () =>
    JSON.parse(
      storage.writeAttachment.mock.calls
        .find((c) => c[1] === 'provider_data')[2]
        .toString(),
    );
  it('retains standard/enriched responses, unknown feature fields and the user profile', async () => {
    await collector.capture(row(), config);
    const data = provider();
    expect(data.decision.nfc_verifications).toEqual([{ chip: 'synthetic' }]);
    expect(data.decision.aml_screenings).toEqual([{ score: 2 }]);
    expect(data.expandedDecision.resubmissions).toEqual([
      { status: 'Declined' },
    ]);
    expect(data.expandedDecision.events).toHaveLength(1);
    expect(data.user.comments).toEqual(['synthetic']);
    expect(data.filesExport.download_url).toBe(
      'https://media.didit.test/file.zip',
    );
    expect(api.decision.mock.calls).toEqual([
      [sessionId, 'synthetic'],
      [sessionId, 'synthetic', true],
    ]);
    expect(storage.writeAttachment.mock.calls.map((c) => c[1])).toEqual([
      'report',
      'original_files',
      'provider_data',
    ]);
    expect(repo.finish).toHaveBeenCalledWith(
      expect.anything(),
      'ready',
      'lease.json',
      null,
    );
  });
  it('captures the beginning of verification, without requiring approval or a PDF', async () => {
    api.decision.mockResolvedValue({
      session_id: sessionId,
      vendor_data: 'user',
      status: 'Not Started',
    });
    await collector.capture(row(), config);
    expect(api.report).not.toHaveBeenCalled();
    expect(provider().coverage.report).toBe('not_applicable_yet');
    expect(repo.finish).toHaveBeenCalledWith(
      expect.anything(),
      'ready',
      'lease.json',
      null,
    );
  });
  it('persists partial data while an asynchronous ZIP is pending, then polls its existing ID', async () => {
    api.exportStatus.mockResolvedValue({
      session_id: sessionId,
      export_id: exportId,
      status: 'PROCESSING',
    });
    await collector.capture({ ...row(), exportId, exportRevision: 1 }, config);
    expect(api.startExport).not.toHaveBeenCalled();
    expect(api.originals).not.toHaveBeenCalled();
    expect(provider().coverage.original_files).toBe('unavailable');
    expect(repo.finish).toHaveBeenCalledWith(
      expect.anything(),
      'pending',
      'lease.json',
      'FULL_EVIDENCE_INCOMPLETE',
    );
  });
  it('retains a partial archive at the retry limit rather than claiming complete collection', async () => {
    api.user.mockRejectedValue(
      new Error('sensitive body which must not be retained'),
    );
    await collector.capture({ ...row(), attempts: 12 }, config);
    expect(provider().coverage.user_profile).toBe('unavailable');
    expect(JSON.stringify(provider())).not.toContain('sensitive body');
    expect(repo.finish).toHaveBeenCalledWith(
      expect.anything(),
      'partial',
      'lease.json',
      'FULL_EVIDENCE_INCOMPLETE',
    );
  });
  it.each(['decision', 'user', 'exportStatus'])(
    'rejects cross-user/cross-session %s data',
    async (method) => {
      api[method].mockResolvedValue({
        session_id: 'other-session',
        vendor_data: 'other-user',
        export_id: exportId,
      });
      await collector.capture(row(), config);
      expect(storage.writeImages).not.toHaveBeenCalled();
      expect(repo.finish).toHaveBeenCalledWith(
        expect.anything(),
        'failed',
        null,
        'SESSION_OWNER_MISMATCH',
      );
    },
  );
  it('never fetches another linked user, session or URL from the decision JSON', async () => {
    api.decision.mockResolvedValue({
      session_id: sessionId,
      vendor_data: 'user',
      status: 'Approved',
      matches: [
        { session_id: 'unrelated', url: 'http://169.254.169.254/secrets' },
      ],
    });
    await collector.capture(row(), config);
    expect(api.user).toHaveBeenCalledTimes(1);
    expect(api.user).toHaveBeenCalledWith('user', 'synthetic');
    expect(api.originals).toHaveBeenCalledTimes(1);
  });
  it('does not collect after expiry or publish after losing the export revision fence', async () => {
    await collector.capture({ ...row(), expiresAt: new Date(0) }, config);
    expect(api.decision).not.toHaveBeenCalled();
    repo.saveExport.mockResolvedValue(false);
    await collector.capture(row(), config);
    expect(api.exportStatus).not.toHaveBeenCalled();
    expect(repo.finish).toHaveBeenLastCalledWith(
      expect.anything(),
      'pending',
      'lease.json',
      'FULL_EVIDENCE_INCOMPLETE',
    );
  });
});

describe('provider field preservation and credential removal', () => {
  it('preserves new structures, nulls, booleans and arrays while stripping capabilities', () => {
    expect(
      archiveProviderData({
        unknown_feature: { score: 0, ok: false, values: [null, 'x'] },
        api_key: 'private',
        access_token: 'private',
        url: 'https://user:password@example.test/file?signature=private#token',
      }),
    ).toEqual({
      unknown_feature: { score: 0, ok: false, values: [null, 'x'] },
      api_key: '[redacted credential]',
      access_token: '[redacted credential]',
      url: 'https://example.test/file',
    });
  });
  it('deduplicates refreshed signed URLs and object ordering but not changed provider data', () => {
    expect(
      providerFingerprint({ b: 1, a: 'https://example.test/a?sig=1' }),
    ).toBe(providerFingerprint({ a: 'https://example.test/a?sig=2', b: 1 }));
    expect(providerFingerprint({ status: 'Approved' })).not.toBe(
      providerFingerprint({ status: 'Declined' }),
    );
  });
  it('allows enriched decisions without session_kind but rejects business or wrong-owner data', () => {
    expect(ownedDecision({ session_id: 's' }, 's', 'u')).toEqual({
      session_id: 's',
    });
    expect(() =>
      ownedDecision({ session_id: 's', session_kind: 'business' }, 's', 'u'),
    ).toThrow('SESSION_OWNER_MISMATCH');
  });
});
