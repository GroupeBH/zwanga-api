import type { BoardingLocationSample } from './boarding-detection';

/** Interpolate only between real fixes: never extrapolate a sleeping phone. */
export function alignBoardingSamples(
  driver: BoardingLocationSample[],
  passenger: BoardingLocationSample[],
  maxAccuracy: number,
  maxSpeed: number,
): {
  driver: BoardingLocationSample[];
  passenger: BoardingLocationSample[];
} | null {
  const pairs: {
    driver: BoardingLocationSample;
    passenger: BoardingLocationSample;
  }[] = [];
  const time = (p: BoardingLocationSample) => Date.parse(p.recordedAt);
  const accurate = (p: BoardingLocationSample) =>
    p.accuracyMeters !== null &&
    Number.isFinite(p.accuracyMeters) &&
    p.accuracyMeters >= 0 &&
    p.accuracyMeters <= maxAccuracy;
  for (const d of driver) {
    if (!accurate(d)) continue;
    const at = time(d);
    const exact = passenger.find((p) => time(p) === at);
    if (exact) {
      if (accurate(exact)) pairs.push({ driver: d, passenger: exact });
      continue;
    }
    const right = passenger.findIndex((p) => time(p) > at);
    if (right < 1) continue;
    const a = passenger[right - 1],
      b = passenger[right];
    const gap = time(b) - time(a);
    if (gap <= 0 || gap > 16_000 || !accurate(a) || !accurate(b)) continue;
    const dx =
      (b.longitude - a.longitude) *
      111_195 *
      Math.cos((a.latitude * Math.PI) / 180);
    const dy = (b.latitude - a.latitude) * 111_195;
    if (Math.hypot(dx, dy) / (gap / 1000) > maxSpeed) continue;
    const fraction = (at - time(a)) / gap;
    pairs.push({
      driver: d,
      passenger: {
        ...a,
        recordedAt: d.recordedAt,
        latitude: a.latitude + (b.latitude - a.latitude) * fraction,
        longitude: a.longitude + (b.longitude - a.longitude) * fraction,
        accuracyMeters: Math.max(a.accuracyMeters!, b.accuracyMeters!),
      },
    });
  }
  // Never hide a newly divergent location behind an old aligned history.
  if (
    pairs.length < 2 ||
    Math.max(time(driver.at(-1)!), time(passenger.at(-1)!)) -
      time(pairs.at(-1)!.driver) >
      16_000
  )
    return null;
  return {
    driver: pairs.map((p) => p.driver),
    passenger: pairs.map((p) => p.passenger),
  };
}
