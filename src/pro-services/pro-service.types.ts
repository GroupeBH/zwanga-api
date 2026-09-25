export const SERVICE_CODES = [
  'documents',
  'vehicles',
  'equipment',
  'fleet',
] as const;
export type ServiceCode = (typeof SERVICE_CODES)[number];
export const CASE_STATES = [
  'submitted',
  'reviewing',
  'needs_info',
  'quoted',
  'accepted',
  'processing',
  'ready',
  'completed',
  'rejected',
  'cancelled',
] as const;
export type CaseState = (typeof CASE_STATES)[number];
export const DOCUMENT_OPTIONS = [
  ['nouveau-permis', 'Nouveau permis'],
  ['renouvellement-permis', 'Renouvellement du permis'],
  ['plaque-immatriculation', 'Immatriculation'],
  ['carte-rose', 'Carte rose'],
  ['mutation', 'Mutation'],
  ['attestation-perte', 'Attestation de perte'],
  ['vignette-annuelle', 'Vignette annuelle'],
  ['controle-technique', 'Contrôle technique'],
  ['autorisation-transport', 'Autorisation de transport'],
  ['assurance-auto', 'Assurance automobile'],
] as const;
export interface ServiceApplication {
  fullName: string;
  phone: string;
  vehicleDescription: string;
  plate?: string;
  documents: string[];
  description: string;
}
export interface ServiceTerms {
  version: string;
  text: string;
  validationReference: string;
  custodyCodes: string[];
  validatedBy: string;
  validatedAt: string;
}
export interface ServiceQuote {
  version: number;
  currency: 'CDF' | 'USD';
  totalMinor: number;
  depositMinor: number;
  providerName: string;
  description: string;
  validUntil: string;
  installments: { dueDate: string; amountMinor: number }[];
  retainedDocuments: { code: string; label: string }[];
  terms: ServiceTerms | null;
}
export const SERVICE_SEEDS = [
  {
    code: 'documents',
    name: 'Documents et autorisations',
    description:
      'Confiez vos démarches à Zwanga. Devis après étude du dossier.',
    availability: 'open',
  },
  {
    code: 'vehicles',
    name: 'Véhicules',
    description: 'Accès à un véhicule et solutions de financement.',
    availability: 'coming_soon',
  },
  {
    code: 'equipment',
    name: 'Équipements professionnels',
    description: 'Équipements pour conducteurs et livreurs.',
    availability: 'coming_soon',
  },
  {
    code: 'fleet',
    name: 'Gestion de flotte',
    description: 'Accompagnement des propriétaires et gestionnaires de flotte.',
    availability: 'coming_soon',
  },
];
