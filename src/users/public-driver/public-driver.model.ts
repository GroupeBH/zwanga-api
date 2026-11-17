import {
  ASSET_PRODUCTS,
  type AssetKind,
} from '../../asset-credit/asset-credit-products';

export type PublicDriverCredit = {
  assetKind: AssetKind;
  status: 'active' | 'settled';
};
export type PublicDriverCard = {
  id: string;
  firstName: string;
  lastName: string;
  profilePicture: string | null;
  driverCategory: 'private' | 'transport' | 'intercity' | null;
  isPhoneVerified: boolean;
  completedTrips: number;
  averageRating: number | null;
  totalRatings: number;
  vehicles: {
    type: string;
    brand: string;
    model: string;
    color: string;
    licensePlate: string;
  }[];
  credits: PublicDriverCredit[];
};

/** No free-text labels, contract IDs, money, dates or overdue status. */
export function publicDriverCredits(rows: unknown): PublicDriverCredit[] {
  if (!Array.isArray(rows)) return [];
  const result: PublicDriverCredit[] = [];
  for (const row of rows as unknown[]) {
    if (!row || typeof row !== 'object') continue;
    const candidate = row as Record<string, unknown>;
    const product = ASSET_PRODUCTS.find(
      (item) => item.kind === candidate.assetKind,
    );
    const status = candidate.status;
    if (!product || (status !== 'active' && status !== 'settled')) continue;
    if (
      !result.some(
        (item) => item.assetKind === product.kind && item.status === status,
      )
    ) {
      result.push({ assetKind: product.kind, status });
    }
  }
  return result;
}

export function publicPhotoUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
