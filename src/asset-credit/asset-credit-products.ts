export const ASSET_PRODUCTS = [
  { kind: 'phone', label: 'Téléphone' },
  { kind: 'helmet', label: 'Casque' },
  { kind: 'gps_tracker', label: 'Traceur GPS' },
  { kind: 'delivery_equipment', label: 'Matériel de livraison' },
  { kind: 'equipment', label: 'Autre équipement' },
  { kind: 'vehicle', label: 'Véhicule' },
] as const;
export type AssetKind = (typeof ASSET_PRODUCTS)[number]['kind'];
export const ASSET_KINDS = ASSET_PRODUCTS.map((product) => product.kind);
