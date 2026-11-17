import { BadRequestException } from '@nestjs/common';

export type ZoneGeometry = {
  type: 'MultiPolygon';
  coordinates: number[][][][];
};

/** Geometry only, WGS84 longitude/latitude. Reject rather than repair boundaries silently. */
export function normalizeZoneGeometry(value: unknown): ZoneGeometry {
  const fail = () => {
    throw new BadRequestException(
      'GeoJSON Polygon/MultiPolygon invalide (maximum 5 000 points).',
    );
  };
  if (!value || typeof value !== 'object') return fail();
  const g = value as { type?: string; coordinates?: unknown };
  const polygons =
    g.type === 'Polygon'
      ? [g.coordinates]
      : g.type === 'MultiPolygon'
        ? g.coordinates
        : null;
  if (!Array.isArray(polygons) || !polygons.length || polygons.length > 100)
    return fail();
  let count = 0,
    rings = 0;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) return fail();
    for (const ring of polygon) {
      if (++rings > 100 || !Array.isArray(ring) || ring.length < 4)
        return fail();
      for (const point of ring) {
        if (
          ++count > 5000 ||
          !Array.isArray(point) ||
          point.length !== 2 ||
          point.some((v) => typeof v !== 'number' || !Number.isFinite(v)) ||
          Math.abs(point[0]) > 180 ||
          Math.abs(point[1]) > 85
        )
          return fail();
      }
      const first = ring[0],
        last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) return fail();
      // Local operational zones only: no ambiguous antimeridian-crossing edges.
      for (let i = 1; i < ring.length; i++)
        if (Math.abs(ring[i][0] - ring[i - 1][0]) > 180) return fail();
    }
  }
  return { type: 'MultiPolygon', coordinates: polygons as number[][][][] };
}

export interface ZoneMonitor {
  outside?: boolean;
  lastAt?: number;
  candidate?: boolean;
  since?: number;
  count?: number;
}
export interface ZoneObservation {
  recordedAt: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
}
export function usableZoneObservation(
  p: ZoneObservation,
  now: number,
): boolean {
  const age = now - Date.parse(p.recordedAt);
  return (
    Number.isFinite(age) &&
    age >= 0 &&
    age <= 45_000 &&
    Number.isFinite(p.latitude) &&
    Math.abs(p.latitude) <= 90 &&
    Number.isFinite(p.longitude) &&
    Math.abs(p.longitude) <= 180 &&
    typeof p.accuracyMeters === 'number' &&
    Number.isFinite(p.accuracyMeters) &&
    p.accuracyMeters >= 0 &&
    p.accuracyMeters <= 35
  );
}

/** Three distinct fixes across at least 20 seconds, with no >30s gap. */
export function advanceZoneMonitor(
  state: ZoneMonitor,
  at: number,
  outside: boolean,
): { state: ZoneMonitor; event?: 'outside' | 'returned' } {
  if (state.lastAt !== undefined && at <= state.lastAt) return { state };
  const stable = state.outside ?? false;
  if (outside === stable) return { state: { outside: stable, lastAt: at } };
  const continuous =
    state.candidate === outside &&
    state.lastAt !== undefined &&
    at - state.lastAt <= 30_000;
  const since = continuous ? state.since! : at;
  const count = continuous ? (state.count ?? 0) + 1 : 1;
  if (count >= 3 && at - since >= 20_000) {
    return {
      state: { outside, lastAt: at },
      event: outside ? 'outside' : 'returned',
    };
  }
  return {
    state: { outside: stable, lastAt: at, candidate: outside, since, count },
  };
}
