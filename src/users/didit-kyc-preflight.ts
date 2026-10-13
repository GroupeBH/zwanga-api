import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DiditWorkflowGuard, type DiditWorkflowPage } from './didit-workflow-guard';

type Config = { apiKey: string; workflowId: string };
type RecordValue = Record<string, unknown>;
const ORIGIN = 'https://verification.didit.me';
const controls = ['documents_allowed', 'is_liveness_enabled', 'face_liveness_method',
  'face_liveness_score_decline_threshold', 'face_liveness_score_review_threshold',
  'is_face_match_enabled', 'face_match_score_decline_threshold', 'face_match_score_review_threshold',
  'is_aml_enabled', 'is_phone_verification_enabled', 'is_email_verification_enabled',
  'is_database_validation_enabled', 'is_ip_analysis_enabled', 'is_nfc_enabled',
  'duplicated_user_action', 'workflow_graph', 'is_simple_workflow',
  'max_retry_attempts', 'retry_window_days', 'session_expiration_time'];

function code(error: unknown): string {
  const e = error as { getResponse?: () => unknown; code?: unknown };
  const response = e?.getResponse?.() as { code?: unknown } | undefined;
  const candidate = response?.code ?? e?.code;
  return typeof candidate === 'string' && /^[A-Z0-9_]{1,64}$/.test(candidate)
    ? candidate : 'KYC_PREFLIGHT_FAILED';
}
function fail(value: string): never { throw Object.assign(new Error(value), { code: value }); }
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('KYC_PREFLIGHT_INVALID_RESPONSE');
  return value as RecordValue;
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sorted(child)]));
  return value;
}
function fingerprint(value: RecordValue): string {
  return createHash('sha256').update(JSON.stringify(sorted(
    Object.fromEntries(controls.map(key => [key, value[key] ?? null])),
  ))).digest('hex');
}

/** No session creation, documents, database connection or implicit publication. */
export async function runDiditPreflight(config: Config, publish = false, request: typeof fetch = fetch) {
  if (!config.apiKey || !/^[A-Za-z0-9_-]+$/.test(config.workflowId)) fail('KYC_PREFLIGHT_CONFIG_MISSING');
  const api = async (path: string, method: 'GET' | 'PATCH' = 'GET', body?: RecordValue): Promise<unknown> => {
    const result = await request(`${ORIGIN}${path}`, {
      method, headers: { 'x-api-key': config.apiKey, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
    });
    if (!result.ok) fail(`KYC_PREFLIGHT_HTTP_${result.status}`);
    return result.json();
  };
  const guard = new DiditWorkflowGuard();
  const check = () => guard.check(config.workflowId, config.apiKey, async offset =>
    await api(`/v3/workflows/?limit=100&offset=${offset}`) as DiditWorkflowPage);
  try {
    await check();
    return { available: true, publishedNow: false };
  } catch (error) {
    if (!publish || code(error) !== 'KYC_WORKFLOW_NOT_PUBLISHED') throw error;
  }

  // Explicit --publish applies only to the configured version, never another flow.
  const path = `/v3/workflows/${encodeURIComponent(config.workflowId)}/`;
  const before = record(await api(path));
  const country = record(before.documents_allowed).COD;
  if (before.uuid !== config.workflowId || before.status !== 'draft' || before.is_archived === true ||
      before.is_liveness_enabled !== true || before.is_face_match_enabled !== true || !country)
    fail('KYC_PREFLIGHT_PUBLICATION_REQUIRES_REVIEW');
  const previousControls = fingerprint(before);
  await api(path, 'PATCH', { status: 'published' });
  const after = record(await api(path));
  if (after.status !== 'published' || after.uuid !== before.uuid || fingerprint(after) !== previousControls)
    fail('KYC_PREFLIGHT_PUBLICATION_NOT_VERIFIED');
  await check();
  return { available: true, publishedNow: true };
}

function loadSsm(profile: string, region: string): Config {
  // stdout stays in memory: no parameter values in process arguments or output.
  try {
    const data = JSON.parse(execFileSync('aws', ['ssm', 'get-parameters', '--names',
      '/zwanga-api/production/env/DIDIT_API_KEY', '/zwanga-api/production/env/DIDIT_WORKFLOW_ID',
      '--with-decryption', '--profile', profile, '--region', region, '--output', 'json', '--no-cli-pager'],
    { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })) as {
      Parameters?: { Name: string; Value: string }[];
    };
    return { apiKey: data.Parameters?.find(p => p.Name.endsWith('/DIDIT_API_KEY'))?.Value ?? '',
      workflowId: data.Parameters?.find(p => p.Name.endsWith('/DIDIT_WORKFLOW_ID'))?.Value ?? '' };
  } catch { return fail('KYC_PREFLIGHT_SSM_READ_FAILED'); }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1] || fallback;
  };
  const main = async () => {
    const config = args.includes('--ssm') ? loadSsm(option('--profile', 'default'), option('--region', 'eu-central-1')) : {
      apiKey: process.env.DIDIT_API_KEY || process.env.DIDIT_KYC_API_KEY || '',
      workflowId: process.env.DIDIT_WORKFLOW_ID || process.env.DIDIT_KYC_WORKFLOW_ID || '',
    };
    return runDiditPreflight(config, args.includes('--publish'));
  };
  main().then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(JSON.stringify({ available: false, code: code(error) })); process.exitCode = 1; });
}
