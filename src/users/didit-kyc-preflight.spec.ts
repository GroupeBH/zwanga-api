import { runDiditPreflight } from './didit-kyc-preflight';

const config = { apiKey: 'test-key', workflowId: 'configured' };
const draft = { uuid: 'configured', workflow_id: 'configured', status: 'draft',
  documents_allowed: { COD: { ID: { enabled: 1 } } }, is_liveness_enabled: true,
  is_face_match_enabled: true, session_expiration_time: 604800 };
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

describe('Didit deployment preflight', () => {
  it('has no external writes in its default mode, including an unpublished workflow', async () => {
    const read = jest.fn().mockResolvedValue(response({ results: [draft] }));
    await expect(runDiditPreflight(config, false, read)).rejects.toMatchObject({
      response: { code: 'KYC_WORKFLOW_NOT_PUBLISHED' },
    });
    expect(read.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });

  it('publishes only the configured version and verifies that identity controls are unchanged', async () => {
    const live = { ...draft, status: 'published', published_at: '2026-10-13T00:00:00Z' };
    const request = jest.fn().mockResolvedValueOnce(response({ results: [draft] }))
      .mockResolvedValueOnce(response(draft)).mockResolvedValueOnce(response(live))
      .mockResolvedValueOnce(response(live)).mockResolvedValueOnce(response({ results: [live] }));
    await expect(runDiditPreflight(config, true, request)).resolves.toEqual({ available: true, publishedNow: true });
    const writes = request.mock.calls.filter(([, options]) => options.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe('https://verification.didit.me/v3/workflows/configured/');
    expect(JSON.parse(writes[0][1].body)).toEqual({ status: 'published' });
    expect(request.mock.calls.some(([url]) => String(url).includes('/session/'))).toBe(false);
  });

  it('is idempotent after a publication or an uncertain response', async () => {
    const request = jest.fn().mockResolvedValue(response({ results: [{ ...draft, status: 'published' }] }));
    await expect(runDiditPreflight(config, true, request)).resolves.toEqual({ available: true, publishedNow: false });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([{ is_liveness_enabled: false }, { is_face_match_enabled: false }, { is_archived: true },
    { uuid: 'other' }, { documents_allowed: {} }])('refuses automatic publication of an unsuitable configuration (%j)', async patch => {
    const request = jest.fn().mockResolvedValueOnce(response({ results: [draft] }))
      .mockResolvedValueOnce(response({ ...draft, ...patch }));
    await expect(runDiditPreflight(config, true, request)).rejects.toMatchObject({ code: 'KYC_PREFLIGHT_PUBLICATION_REQUIRES_REVIEW' });
    expect(request.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });

  it('detects altered verification controls after publication', async () => {
    const changed = { ...draft, status: 'published', is_face_match_enabled: false };
    const request = jest.fn().mockResolvedValueOnce(response({ results: [draft] }))
      .mockResolvedValueOnce(response(draft)).mockResolvedValueOnce(response(changed)).mockResolvedValueOnce(response(changed));
    await expect(runDiditPreflight(config, true, request)).rejects.toMatchObject({ code: 'KYC_PREFLIGHT_PUBLICATION_NOT_VERIFIED' });
  });
});
