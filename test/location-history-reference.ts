import type { LocationHistorySnapshot, TrackedLocationPoint } from '../src/common/services/location-history.service';

// Independent TypeScript oracle for the pre-optimization history semantics.
// Only tests use this: real Redis integration compares the Lua result against it.
export function mergeHistoryReference(
  existing: LocationHistorySnapshot | null,
  current: TrackedLocationPoint,
  native: TrackedLocationPoint[],
  hasBatch: boolean,
): LocationHistorySnapshot {
  if (existing?.current && Date.parse(current.recordedAt) < Date.parse(existing.current.recordedAt)) return existing;
  const old = existing?.samples?.length ? existing.samples :
    [existing?.previous, existing?.current].filter((p): p is TrackedLocationPoint => Boolean(p));
  if (hasBatch) {
    const merged = new Map([...native, ...old, current].map(p => [p.recordedAt, p]));
    const samples = [...merged.values()].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt)).slice(-10);
    return { previous: samples.at(-2) ?? null, current: samples.at(-1)!, samples };
  }
  const before = existing?.current;
  let duplicate = false;
  if (before && Math.abs(Date.parse(current.recordedAt) - Date.parse(before.recordedAt)) <= 20000) {
    const rad = Math.PI / 180;
    const a = Math.sin((current.latitude - before.latitude) * rad / 2) ** 2 +
      Math.cos(before.latitude * rad) * Math.cos(current.latitude * rad) *
      Math.sin((current.longitude - before.longitude) * rad / 2) ** 2;
    duplicate = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= 3;
  }
  const samples = [...(duplicate ? old.slice(0, -1) : old), current].slice(-10);
  return { previous: samples.at(-2) ?? (duplicate ? existing?.previous : existing?.current) ?? null,
    current, samples };
}
