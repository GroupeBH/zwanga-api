import type { Point } from 'typeorm';
import type { LocationHistorySnapshot } from '../common/services/location-history.service';

/** A short, recent, accurate observed segment, never an extrapolated route. */
export function hasRecentDestinationPassage(
  history: LocationHistorySnapshot | null | undefined,
  destination: Point | null,
  now: Date,
  notBefore?: Date | string | null,
): boolean {
  if (!destination?.coordinates) return false;
  const [lng, lat] = destination.coordinates;
  if (![lng, lat].every(Number.isFinite)) return false;
  const start = notBefore ? new Date(notBefore).getTime() : -Infinity;
  if (Number.isNaN(start) || !Number.isFinite(now.getTime())) return false;
  const samples = (history?.samples ?? [history?.previous, history?.current])
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  const project = (p: (typeof samples)[number]) => ({
    x: (p.longitude - lng) * 111_195 * Math.cos((lat * Math.PI) / 180),
    y: (p.latitude - lat) * 111_195,
  });
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1],
      b = samples[i];
    const ta = Date.parse(a.recordedAt),
      tb = Date.parse(b.recordedAt);
    if (
      ![ta, tb].every(Number.isFinite) ||
      ta < start ||
      tb > now.getTime() ||
      now.getTime() - ta > 90_000 ||
      tb - ta <= 0 ||
      tb - ta > 30_000 ||
      [a, b].some(
        (p) =>
          p.accuracyMeters === null ||
          !Number.isFinite(p.accuracyMeters) ||
          p.accuracyMeters < 0 ||
          p.accuracyMeters > 35,
      )
    )
      continue;
    const p = project(a),
      q = project(b),
      dx = q.x - p.x,
      dy = q.y - p.y;
    const length = Math.hypot(dx, dy);
    if (
      !Number.isFinite(length) ||
      length < 3 ||
      length > 250 ||
      length / ((tb - ta) / 1000) > 55
    )
      continue;
    const ratio = -(p.x * dx + p.y * dy) / (length * length);
    if (
      ratio >= 0 &&
      ratio <= 1 &&
      Math.hypot(p.x + ratio * dx, p.y + ratio * dy) <= 25
    )
      return true;
  }
  return false;
}
