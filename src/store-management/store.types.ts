export const STORE_PLATFORMS = ['google', 'apple'] as const;
export type StorePlatform = (typeof STORE_PLATFORMS)[number];
export const STORE_TASKS = [
  'catalog',
  'reviews',
  'reports',
  'vitals',
  'connection',
] as const;
export type StoreTask = (typeof STORE_TASKS)[number];
export type StoreJobTask = StoreTask | 'reply' | 'analytics_request';
export type StoreKind =
  'app' | 'review' | 'release' | 'build' | 'report' | 'performance';
export interface StoreItem {
  kind: StoreKind;
  externalId: string;
  content: Record<string, unknown>;
}
export interface StorePoint {
  date: string;
  metric: string;
  dimension: string;
  value: number;
}
/** Each partition is a COMPLETE daily snapshot, never an additive delta. */
export interface StorePartition {
  dataset: string;
  date: string;
  revision: string;
  points: StorePoint[];
}
export interface StoreBatch {
  integrationCheck?: Record<string, { available: boolean; errorCode?: string }>;
  items?: StoreItem[];
  replaceKinds?: StoreKind[];
  partitions?: StorePartition[];
}
export interface StoreRange {
  from: string;
  to: string;
}

/** Safe codes only: never propagate Axios errors (they contain authorization). */
export class StoreProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly retryAfterSeconds = 0,
    readonly ambiguous = false,
  ) {
    super(code);
  }
}

export const day = (date = new Date()) => date.toISOString().slice(0, 10);
export const identifier = (value: string) => encodeURIComponent(value);
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new StoreProviderError('INVALID_PROVIDER_RESPONSE');
  return value as Record<string, any>;
}
export function list(value: unknown): any[] {
  if (!Array.isArray(value))
    throw new StoreProviderError('INVALID_PROVIDER_RESPONSE');
  return value;
}
export function textValue(value: unknown, max = 10000): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > max)
    throw new StoreProviderError('INVALID_PROVIDER_RESPONSE');
  return value;
}
