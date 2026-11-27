import { BadRequestException } from '@nestjs/common';

export type ManualField = {
  key: string;
  label: string;
  type: 'text' | 'date' | 'number' | 'boolean' | 'email';
  maxLength: number;
};
const group = (
  id: string,
  title: string,
  entries: string[],
): { id: string; title: string; fields: ManualField[] } => ({
  id,
  title,
  fields: entries.map((entry) => {
    const [key, label, type = 'text'] = entry.split('|');
    return { key, label, type: type as ManualField['type'], maxLength: 1000 };
  }),
});
// These are administrator declarations, never provider decisions or account flags.
// The schema drives both API validation and the admin form (no duplicated rules).
export const MANUAL_KYC_SCHEMA = [
  group('identity', 'Identité et document', [
    'full_name|Nom complet',
    'first_name|Prénom',
    'middle_name|Postnom',
    'last_name|Nom',
    'date_of_birth|Date de naissance|date',
    'gender|Sexe',
    'nationality|Nationalité',
    'document_number|Numéro du document',
    'personal_number|Numéro personnel',
    'document_type|Type de document',
    'issuing_state|Pays émetteur',
    'expiration_date|Date d’expiration|date',
    'date_of_issue|Date de délivrance|date',
  ]),
  group('contact', 'Coordonnées et adresse', [
    'email|Email|email',
    'mobile_country_code|Indicatif téléphonique',
    'mobile|Téléphone',
    'address_line_1|Adresse',
    'address_line_2|Complément d’adresse',
    'address_city|Ville',
    'address_state|Province',
    'address_country|Pays',
    'address_zip_code|Code postal',
  ]),
  group('reference', 'Références déclarées du contrôle', [
    'session_id|Référence de session externe',
    'session_number|Numéro de session externe|number',
    'session_status|Résultat externe déclaré',
    'original_status|Résultat initial déclaré',
    'tags|Étiquettes',
    'created_at|Date du contrôle externe',
    'workflow_type|Type de contrôle',
    'total_cost|Coût déclaré|number',
  ]),
  group('technical', 'Contexte technique déclaré', [
    'ip_location_country|Pays de l’adresse IP',
    'ip_address|Adresse IP',
    'device_brand|Marque de l’appareil',
    'device_model|Modèle',
    'platform|Plateforme',
    'browser|Navigateur',
    'is_vpn_or_tor|VPN ou Tor signalé|boolean',
    'is_datacenter|Adresse de datacenter signalée|boolean',
  ]),
  group('checks', 'Observations de contrôle (saisies manuellement)', [
    'liveness_status|Résultat de présence déclaré',
    'face_match_status|Concordance faciale déclarée',
    'face_match_score|Score facial déclaré|number',
    'aml_status|Résultat AML déclaré',
    'aml_matches_count|Correspondances AML déclarées|number',
    'aml_monitoring_enabled|Surveillance AML déclarée|boolean',
    'warnings|Avertissements et réserves',
  ]),
  group('address_proof', 'Justificatif de domicile', [
    'poa_name_on_document|Nom figurant sur le justificatif',
    'poa_issuing_state|Pays émetteur',
    'poa_document_type|Type de justificatif',
    'poa_document_language|Langue',
    'poa_issuer|Émetteur',
    'poa_issue_date|Date d’émission|date',
    'poa_address_line_1|Adresse',
    'poa_address_line_2|Complément d’adresse',
    'poa_address_city|Ville',
    'poa_address_state|Province',
    'poa_address_country|Pays',
    'poa_address_zip_code|Code postal',
  ]),
  group('consent', 'Éléments déclarés relatifs au consentement', [
    'biometric_consent_required|Consentement demandé|boolean',
    'biometric_consent_trigger|Motif de la demande',
    'biometric_consent_status|État du consentement déclaré',
    'biometric_consent_at|Date et heure déclarées',
    'biometric_consent_text_version|Version du texte présenté',
    'biometric_consent_ip_address|Adresse IP déclarée',
    'biometric_consent_ip_country|Pays déclaré',
    'biometric_consent_ip_state|Province déclarée',
  ]),
];
export type ManualKycInput = {
  kycId: string | null;
  baseRevision: number;
  note: string;
  fields: Record<string, string>;
};
export function parseManualKycInput(raw: unknown): ManualKycInput {
  const invalid = () =>
    new BadRequestException(
      'Saisie KYC invalide : vérifiez les champs et le compte rendu.',
    );
  let value: any;
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 64 * 1024)
      throw invalid();
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['kycId', 'baseRevision', 'note', 'fields'].includes(key),
    ) ||
    (value.kycId !== null &&
      (typeof value.kycId !== 'string' ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.kycId))) ||
    !Number.isSafeInteger(value.baseRevision) ||
    value.baseRevision < 0 ||
    typeof value.note !== 'string' ||
    value.note.trim().length < 10 ||
    value.note.length > 2000 ||
    !value.fields ||
    typeof value.fields !== 'object' ||
    Array.isArray(value.fields)
  )
    throw invalid();
  const definitions = new Map(
    MANUAL_KYC_SCHEMA.flatMap((g) => g.fields.map((f) => [f.key, f] as const)),
  );
  const fields: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.fields)) {
    const definition = definitions.get(key);
    if (
      !definition ||
      typeof entry !== 'string' ||
      entry.length > definition.maxLength ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(entry)
    )
      throw invalid();
    const text = entry.trim();
    if (!text) continue;
    if (
      definition.type === 'date' &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(text) ||
        !Number.isFinite(Date.parse(text)) ||
        new Date(text).toISOString().slice(0, 10) !== text)
    )
      throw invalid();
    if (definition.type === 'boolean' && !['true', 'false'].includes(text))
      throw invalid();
    if (
      definition.type === 'number' &&
      (!/^\d+(?:\.\d+)?$/.test(text) ||
        !Number.isFinite(Number(text)) ||
        Number(text) > 1e12)
    )
      throw invalid();
    if (definition.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))
      throw invalid();
    fields[key] = text;
  }
  return {
    kycId: value.kycId,
    baseRevision: value.baseRevision,
    note: value.note.trim(),
    fields,
  };
}
