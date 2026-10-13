import { DiditWorkflowGuard, assertDiditSessionUsable } from './didit-workflow-guard';

describe('Didit published workflow guard', () => {
  it('rejects the production incident: selected draft while another group is published', async () => {
    const read = jest.fn().mockResolvedValue({ results: [
      { uuid: 'configured', workflow_id: 'configured', status: 'draft', version: 1 },
      { uuid: 'other', workflow_id: 'other', status: 'published', version: 1 },
    ] });
    await expect(new DiditWorkflowGuard().check('configured', 'test-key', read)).rejects.toMatchObject({
      response: { code: 'KYC_WORKFLOW_NOT_PUBLISHED' },
    });
  });

  it('resolves a configured version to its own published group across pinned pagination', async () => {
    const read = jest.fn()
      .mockResolvedValueOnce({ results: [{ uuid: 'draft-id', workflow_id: 'group', status: 'draft' }], next: 'https://untrusted.test/' })
      .mockResolvedValueOnce({ results: [{ uuid: 'live-id', workflow_id: 'group', status: 'published', version: 2 }] });
    await expect(new DiditWorkflowGuard().check('draft-id', 'test-key', read)).resolves.toBe('group');
    expect(read.mock.calls).toEqual([[0], [100]]);
  });

  it('shares concurrent checks and only caches a successful publication check', async () => {
    const guard = new DiditWorkflowGuard();
    const read = jest.fn().mockResolvedValue({ results: [{ uuid: 'id', workflow_id: 'id', status: 'published' }] });
    expect(await Promise.all([guard.check('id', 'test-key', read), guard.check('id', 'test-key', read)]))
      .toEqual(['id', 'id']);
    await guard.check('id', 'test-key', read); expect(read).toHaveBeenCalledTimes(1);
    await guard.check('id', 'new-key', read); expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not cache a draft failure, so publication can enable the next attempt immediately', async () => {
    const guard = new DiditWorkflowGuard();
    const read = jest.fn().mockResolvedValueOnce({ results: [{ uuid: 'id', status: 'draft' }] })
      .mockResolvedValueOnce({ results: [{ uuid: 'id', status: 'published' }] });
    await expect(guard.check('id', 'key', read)).rejects.toThrow();
    await expect(guard.check('id', 'key', read)).resolves.toBe('id');
  });

  it('rejects malformed, archived or incompletely scanned workflows', async () => {
    for (const page of [{}, { results: [{ uuid: 'id', status: 'published', is_archived: true }] },
      { results: [{ uuid: 'id', status: 'published' }], next: 'more' }]) {
      await expect(new DiditWorkflowGuard().check('id', 'key', async () => page)).rejects.toThrow();
    }
  });
});

describe('Didit session freshness', () => {
  it.each(['Expired', 'Abandoned', 'Declined', 'Approved', 'rejected'])('refuses a terminal provider session (%s)', status => {
    expect(() => assertDiditSessionUsable(status, null)).toThrow();
  });
  it.each(['invalid-date', '', '2000-01-01T00:00:00Z', 123])('refuses malformed or elapsed expiration (%s)', expiry => {
    expect(() => assertDiditSessionUsable('Not Started', expiry)).toThrow();
  });
  it('preserves old API replies without expiration and exposes a valid future timestamp', () => {
    expect(assertDiditSessionUsable('Not Started', undefined)).toBeNull();
    const expiry = new Date(Date.now() + 3600000).toISOString();
    expect(assertDiditSessionUsable('Not Started', expiry)).toBe(expiry);
  });
});
