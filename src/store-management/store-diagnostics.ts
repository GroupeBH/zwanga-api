import { StoreConfig } from './store.config';
import { StoreSyncJob } from './store.entities';
import { StoreIntegration } from './store-operations.entities';
import { StorePlatform } from './store.types';

export const STORE_DATA_TASKS = [
  'reviews',
  'catalog',
  'reports',
  'vitals',
] as const;
export type StoreDataTask = (typeof STORE_DATA_TASKS)[number];
type Capability = { available: boolean; errorCode?: string };
const CAPABILITIES: Record<StorePlatform, Record<StoreDataTask, string[]>> = {
  google: {
    reviews: ['publisher_reviews_read'],
    catalog: [],
    reports: ['statistics_read'],
    vitals: ['android_vitals_read'],
  },
  apple: {
    reviews: ['reviews_read'],
    catalog: ['application_read', 'versions_read', 'builds_read'],
    reports: ['analytics_read', 'analytics_reports_requested'],
    vitals: ['analytics_read', 'analytics_reports_requested'],
  },
};

/** Local evidence only. An HTTP success on one API never validates another source. */
export function storeSourceDiagnostics(
  config: StoreConfig,
  platform: StorePlatform,
  integration: StoreIntegration | undefined,
  jobs: StoreSyncJob[],
) {
  let baseCode: string | null = null;
  const missing = config.missing(platform);
  if (config.enabled && !missing.length) {
    try {
      config.assertReady(platform);
    } catch (error) {
      const response =
        typeof error?.getResponse === 'function' ? error.getResponse() : null;
      baseCode = response?.code ?? 'STORE_NOT_CONFIGURED';
    }
  }
  return {
    platform,
    appId: config.appId(platform) || null,
    checkedAt: integration?.checkedAt ?? null,
    sources: STORE_DATA_TASKS.map((task) => {
      const job = jobs.find((j) => j.task === task);
      const blocker = config.taskBlocker(platform, task);
      const caps = CAPABILITIES[platform][task].map(
        (name) => integration?.capabilities?.[name] as Capability | undefined,
      );
      const failure = caps.find((c) => c?.available === false);
      const newerSuccessfulImport =
        job?.state === 'succeeded' &&
        (!integration?.checkedAt ||
          (job.completedAt && job.completedAt > integration.checkedAt));
      let state:
        | 'disabled'
        | 'configuration_required'
        | 'unavailable'
        | 'unchecked'
        | 'ready';
      let reasonCode: string | null;
      if (!config.enabled || (integration && !integration.enabled)) {
        state = 'disabled';
        reasonCode = 'STORE_DISABLED';
      } else if (!integration) {
        state = 'configuration_required';
        reasonCode = 'STORE_INTEGRATION_NOT_INITIALIZED';
      } else if (missing.length || baseCode || blocker) {
        state = 'configuration_required';
        reasonCode = baseCode ?? blocker?.code ?? 'STORE_NOT_CONFIGURED';
      } else if (newerSuccessfulImport) {
        state = 'ready';
        reasonCode = null;
      } else if (
        integration.errorCode &&
        integration.errorCode !== 'CAPABILITY_CHECK_FAILED'
      ) {
        state = 'unavailable';
        reasonCode = integration.errorCode;
      } else if (failure) {
        state = 'unavailable';
        reasonCode = failure.errorCode ?? 'CAPABILITY_CHECK_FAILED';
      } else if (
        job?.state === 'succeeded' ||
        (caps.length && caps.every((c) => c?.available))
      ) {
        state = 'ready';
        reasonCode = null;
      } else {
        state = 'unchecked';
        reasonCode =
          integration.errorCode &&
          integration.errorCode !== 'CAPABILITY_CHECK_FAILED'
            ? integration.errorCode
            : null;
      }
      return {
        task,
        state,
        reasonCode,
        missingVariables: [...missing, ...(blocker?.missingVariables ?? [])],
        // Explicit projection: never expose job input, reply text, lease or provider errors.
        lastJob: job
          ? {
              id: job.id,
              state: job.state,
              processed: job.processed,
              errorCode: job.errorCode,
              createdAt: job.createdAt,
              completedAt: job.completedAt,
            }
          : null,
      };
    }),
  };
}
