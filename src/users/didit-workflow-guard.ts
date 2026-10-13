import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';

type Workflow = { uuid?: string; workflow_id?: string; status?: string; is_archived?: boolean; version?: number };
export type DiditWorkflowPage = { results?: Workflow[]; next?: string | null };

// Operational publication diagnostic only, not a prerequisite for createSession.
// The session API remains authoritative for the configured workflow's usability.
export class DiditWorkflowGuard {
  private cached: { key: string; id: string; until: number } | null = null;
  private pending: { key: string; task: Promise<string> } | null = null;

  async check(id: string, apiKey: string, read: (offset: number) => Promise<DiditWorkflowPage>): Promise<string> {
    const key = createHash('sha256').update(JSON.stringify([id, apiKey])).digest('hex');
    if (this.cached?.key === key && this.cached.until > Date.now()) return this.cached.id;
    if (this.pending?.key === key) return this.pending.task;
    const task = this.load(id, read);
    this.pending = { key, task };
    try {
      const publishedId = await task;
      this.cached = { key, id: publishedId, until: Date.now() + 60_000 };
      return publishedId;
    } finally {
      if (this.pending?.task === task) this.pending = null;
    }
  }

  private async load(id: string, read: (offset: number) => Promise<DiditWorkflowPage>): Promise<string> {
    const rows: Workflow[] = [];
    for (let page = 0; page < 5; page++) {
      const result = await read(page * 100);
      if (!Array.isArray(result.results)) throw new BadGatewayException({
        code: 'KYC_WORKFLOW_INVALID_RESPONSE', message: 'Le service de vérification a renvoyé une réponse inattendue.',
      });
      rows.push(...result.results);
      if (!result.next) break;
      if (page === 4) throw new ServiceUnavailableException({
        code: 'KYC_WORKFLOW_CHECK_INCOMPLETE', message: 'La configuration de vérification doit être contrôlée par le support.',
      });
      // Never follow the provider's URL with our API key; rebuild a pinned-origin path.
    }
    const exact = rows.find(row => row.uuid === id);
    const group = exact?.workflow_id || id;
    const published = rows.filter(row => (row.workflow_id === group || row.uuid === group) &&
      row.status === 'published' && row.is_archived !== true)
      .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
    if (!published) throw new ServiceUnavailableException({
      code: 'KYC_WORKFLOW_NOT_PUBLISHED',
      message: 'La vérification d’identité est momentanément indisponible. Notre équipe doit finaliser sa configuration.',
    });
    return published.workflow_id || group;
  }
}

export function assertDiditSessionUsable(status: string | null, expiresAt: unknown): string | null {
  const terminal = ['expired', 'abandoned', 'declined', 'rejected', 'approved'];
  const normalized = status?.trim().toLowerCase();
  const expiry = expiresAt === undefined || expiresAt === null ? null :
    typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if (terminal.includes(normalized ?? '') || (expiry !== null && (!Number.isFinite(expiry) || expiry <= Date.now()))) {
    throw new BadGatewayException({ code: 'KYC_PROVIDER_UNUSABLE_SESSION',
      message: 'Le service de vérification n’a pas fourni de session utilisable. Réessayez plus tard.' });
  }
  return expiry === null ? null : new Date(expiry).toISOString();
}
