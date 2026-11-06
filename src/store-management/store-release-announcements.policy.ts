import { normalizeAppVersion } from '../app-updates/app-update.policy';
import type { StorePlatform } from './store.types';

export interface StoreAnnouncement {
  platform: 'android' | 'ios';
  version: string;
  build: string;
  notes: string;
  comparison: 'native_build' | 'version_build';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function version(value: unknown): string | null {
  return typeof value === 'string' ? normalizeAppVersion(value) : null;
}
function compare(a: string, b: string): number {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Only public, completed distributions. A Google release name is NOT a versionName. */
export function storeAnnouncements(
  platform: StorePlatform,
  contents: unknown[],
): StoreAnnouncement[] {
  const result: StoreAnnouncement[] = [];
  for (const content of contents) {
    const item = record(content);
    if (platform === 'google') {
      if (item.track !== 'production' || !Array.isArray(item.releases))
        continue;
      for (const value of item.releases) {
        const release = record(value);
        if (
          release.status !== 'completed' ||
          (release.userFraction != null && release.userFraction !== 1) ||
          release.countryTargeting != null ||
          !Array.isArray(release.versionCodes) ||
          release.versionCodes.length !== 1
        )
          continue;
        const rawBuild: unknown = release.versionCodes[0];
        if (typeof rawBuild !== 'string' || !/^[1-9]\d{0,9}$/.test(rawBuild))
          continue;
        const build = version(rawBuild);
        if (!build) continue;
        // Google tracks expose a freely chosen release name, not the binary's
        // versionName. Use the authoritative versionCode, never guess a version.
        result.push({
          platform: 'android',
          version: '0.0.0',
          build,
          notes: '',
          comparison: 'native_build',
        });
      }
    } else {
      if (
        item.platform !== 'IOS' ||
        typeof item.appStoreState !== 'string' ||
        !['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'].includes(
          item.appStoreState,
        ) ||
        (item.phasedReleaseState != null &&
          (typeof item.phasedReleaseState !== 'string' ||
            !['COMPLETE', 'INACTIVE'].includes(item.phasedReleaseState))) ||
        (item.earliestReleaseDate != null &&
          (typeof item.earliestReleaseDate !== 'string' ||
            !Number.isFinite(Date.parse(item.earliestReleaseDate)) ||
            Date.parse(item.earliestReleaseDate) > Date.now()))
      )
        continue;
      const releaseVersion = version(item.versionString),
        build = version(item.buildVersion);
      if (!releaseVersion || !build) continue;
      result.push({
        platform: 'ios',
        version: releaseVersion,
        build,
        notes: '',
        comparison: 'version_build',
      });
    }
  }
  return result.sort((a, b) =>
    platform === 'google'
      ? compare(b.build, a.build)
      : compare(b.version, a.version) || compare(b.build, a.build),
  );
}
