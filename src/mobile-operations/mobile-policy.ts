import { BadRequestException } from '@nestjs/common';
import { normalizeAppVersion } from '../app-updates/app-update.policy';

export function nativeBuild(value: string): string {
  const result = normalizeAppVersion(value);
  if (!result) throw new BadRequestException('Numéro de build invalide.');
  return result;
}
export function compareBuild(a: string, b: string): number {
  const x = nativeBuild(a).split('.').map(Number),
    y = nativeBuild(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
export function campaignCategory(kind: string) {
  // Sign-up and new-feature invitations are promotional, never operational consent bypasses.
  return kind === 'update'
    ? 'updates'
    : ['maintenance', 'operational'].includes(kind)
      ? 'operational'
      : 'marketing';
}
export function validStoreUrl(platform: string, value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash &&
      (platform === 'android'
        ? u.hostname === 'play.google.com' &&
          u.pathname === '/store/apps/details' &&
          u.searchParams.get('id') === 'com.zwanga' &&
          [...u.searchParams.keys()].every((k) => k === 'id')
        : u.hostname === 'apps.apple.com' &&
          /^\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id6756211830$/.test(u.pathname) &&
          !u.search)
    );
  } catch {
    return false;
  }
}
export function policyDecision(policy: any | undefined, build: string) {
  const none = {
    updateAvailable: false,
    mode: 'NONE',
    required: false,
    blockedFeatures: [] as string[],
    validForSeconds: 300,
    protectedOperations: ['ongoing_trip', 'finish_trip', 'safety', 'support'],
    buildTrust: 'client_declared',
  };
  if (!policy || !policy.available || !policy.availabilityConfirmed)
    return none;
  const updateAvailable = compareBuild(build, policy.build) < 0;
  const required =
    updateAvailable &&
    policy.mode === 'REQUIRED' &&
    compareBuild(build, policy.minimumBuild) < 0;
  return {
    ...none,
    updateAvailable: updateAvailable && policy.mode !== 'NONE',
    mode: !updateAvailable
      ? 'NONE'
      : required
        ? 'REQUIRED'
        : policy.mode === 'REQUIRED'
          ? 'RECOMMENDED'
          : policy.mode,
    required,
    policyId: policy.id,
    revision: policy.revision,
    recommendedVersion: policy.version,
    recommendedBuild: policy.build,
    minimumVersion: policy.minimumVersion,
    minimumBuild: policy.minimumBuild,
    message: policy.message,
    storeUrl: policy.storeUrl,
    blockedFeatures: required ? policy.blockedFeatures : [],
    validForSeconds: policy.expiresAt
      ? Math.max(
          0,
          Math.min(
            300,
            Math.floor(
              (new Date(policy.expiresAt).getTime() - Date.now()) / 1000,
            ),
          ),
        )
      : 300,
  };
}
