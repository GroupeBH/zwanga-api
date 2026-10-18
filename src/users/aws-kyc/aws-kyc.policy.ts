import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

export const AWS_KYC_CONSENT = 'aws-kyc-v1';
export const AWS_DOCUMENT_TYPES = [
  'voter_card',
  'passport',
  'driving_license',
] as const;
export type AwsDocumentType = (typeof AWS_DOCUMENT_TYPES)[number];
export const ACTIVE_STATES = [
  'uploading',
  'documents',
  'ready',
  'creating',
  'liveness',
  'compare',
  'review',
];
export type AwsKycState =
  | 'uploading'
  | 'documents'
  | 'ready'
  | 'creating'
  | 'liveness'
  | 'compare'
  | 'review'
  | 'failed';
export type OcrLine = { text: string; confidence: number };
export const AWS_KYC_DECISION_VERSION = 'aws-kyc-authenticity-review-v2';

// Eligibility is not an authenticity certificate. Missing/old checks fail closed
// into manual review, never into approval. Scores and reasons remain server-side.
export function awsKycDecision(checks: Record<string, string>) {
  const reasons = [
    // No trusted document-authentication integration exists for these RDC
    // documents yet. OCR/liveness (or a supplied "authenticity" flag) cannot
    // attest authenticity. Keep automatic analysis, require an admin decision.
    'DOCUMENT_AUTHENTICITY_UNVERIFIED',
    ...(checks.document !== 'consistent' ? ['DOCUMENT_UNCERTAIN'] : []),
    ...(checks.names !== 'match' ? ['NAMES_UNCERTAIN'] : []),
    ...(!['valid', 'not_required'].includes(checks.validity)
      ? ['VALIDITY_UNCERTAIN']
      : []),
    ...(checks.ocr !== 'confident' ? ['OCR_UNCERTAIN'] : []),
    ...(checks.liveness !== 'passed' ? ['LIVENESS_UNCERTAIN'] : []),
    ...(checks.face !== 'passed' ? ['FACE_UNCERTAIN'] : []),
  ];
  return {
    mode: reasons.length ? 'manual_review' : 'automatic',
    reasons,
  } as const;
}

export function awsKycConfig(c: ConfigService) {
  if (String(c.get('AWS_KYC_ENABLED')) !== 'true') return null;
  const region = c.get<string>('AWS_KYC_REGION') || 'eu-west-1';
  const roleArn = c.get<string>('AWS_KYC_LIVENESS_ROLE_ARN') || '';
  const number = (key: string, fallback: number, min: number, max: number) => {
    const n = Number(c.get(key) ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new ServiceUnavailableException({ code: 'AWS_KYC_CONFIGURATION_REQUIRED', message: 'Configuration KYC AWS invalide.' });
    return n;
  };
  if (
    ![
      'eu-west-1',
      'us-east-1',
      'us-west-2',
      'ap-northeast-1',
      'ap-south-1',
    ].includes(region) ||
    !/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(roleArn) ||
    !c.get('AWS_S3_BUCKET_NAME') ||
    String(c.get('AWS_S3_PUBLIC_BUCKET')) === 'true'
  ) {
    throw new ServiceUnavailableException({
      code: 'AWS_KYC_CONFIGURATION_REQUIRED',
      message: 'Stockage privé et rôle de capture KYC AWS requis.',
    });
  }
  return {
    region,
    roleArn,
    // Explicit cutover only: coexistence keeps an in-flight Didit dossier intact.
    replacePendingDidit: c.get<string>('KYC_PROVIDER') === 'aws',
    daily: number('AWS_KYC_DAILY_LIMIT', 100, 1, 10000),
    monthly: number('AWS_KYC_MONTHLY_LIMIT', 1000, 1, 100000),
    perUser: number('AWS_KYC_USER_DAILY_LIMIT', 3, 1, 5),
    liveness: number('AWS_KYC_LIVENESS_THRESHOLD', 95, 90, 100),
    similarity: number('AWS_KYC_FACE_THRESHOLD', 95, 90, 100),
  };
}

// Configuration readiness only: this does not assert live IAM/S3 availability
// or create a metered AWS session. Never expose configuration values here.
export function awsKycAvailability(c: ConfigService) {
  try {
    return awsKycConfig(c)
      ? { enabled: true, unavailableCode: null }
      : { enabled: false, unavailableCode: 'AWS_KYC_DISABLED' };
  } catch (error) {
    if (!(error instanceof ServiceUnavailableException)) throw error;
    return { enabled: false, unavailableCode: 'AWS_KYC_CONFIGURATION_REQUIRED' };
  }
}

export const canonicalName = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
export const identityHash = (first: string, last: string) =>
  createHash('sha256')
    .update(JSON.stringify([canonicalName(first), canonicalName(last)]))
    .digest('hex');

// These are consistency checks, NOT document authentication or official RDC templates.
// Never search the whole page for a user's name: names must come from named fields.
export function inspectDocument(
  lines: OcrLine[],
  type: AwsDocumentType,
  first: string,
  last: string,
  now = new Date(),
) {
  const values = lines
    .slice(0, 500)
    .map((l) => ({
      text: canonicalName(l.text),
      confidence: Number.isFinite(l.confidence) ? l.confidence : 0,
    }));
  const issuerPattern =
    /\b(?:REPUBLIQUE DEMOCRATIQUE DU CONGO|DEMOCRATIC REPUBLIC OF (?:THE )?CONGO)\b/;
  const issuer = values.some((_, i) => {
    // Country headers can span several OCR lines; all contributing lines must be confident.
    for (let length = 1; length <= 3; length++) {
      const block = values.slice(i, i + length);
      if (
        block.every((v) => v.confidence >= 95) &&
        issuerPattern.test(block.map((v) => v.text).join(' '))
      )
        return true;
    }
    return false;
  });
  const labels: Record<AwsDocumentType, RegExp> = {
    voter_card: /\bCARTE D ELECTEUR\b/,
    passport: /\b(?:PASSEPORT|PASSPORT)\b/,
    driving_license: /\b(?:PERMIS DE CONDUIRE|DRIVING LICEN[CS]E)\b/,
  };
  const recognizedTypes = AWS_DOCUMENT_TYPES.filter((t) =>
    values.some((v) => labels[t].test(v.text)),
  );
  const document =
    issuer &&
    recognizedTypes.length === 1 &&
    recognizedTypes[0] === type &&
    values.some((v) => v.confidence >= 95 && labels[type].test(v.text))
      ? 'consistent'
      : 'unrecognized';
  const field = (label: RegExp) => {
    const matches = values.flatMap((v, i) => {
      const match = v.text.match(label);
      if (!match) return [];
      const inline = v.text.slice(match[0].length).trim();
      const candidate = inline || values[i + 1]?.text;
      return [
        {
          value:
            candidate &&
            !/^(NOM|PRENOM|POST NOM|DATE|SEXE|NATIONALITE|LIEU|NUMERO)\b/.test(
              candidate,
            )
              ? candidate
              : null,
          confidence: inline
            ? v.confidence
            : Math.min(v.confidence, values[i + 1]?.confidence ?? 0),
        },
      ];
    });
    return {
      ...(matches.length === 1 ? matches[0] : { value: null, confidence: 0 }),
      present: matches.length > 0,
    };
  };
  const given = field(/^(?:PRENOM(?:S)?|GIVEN NAMES?)(?:\s+|$)/);
  const surname = field(/^(?:NOM|SURNAME)(?:\s+|$)/);
  const postName = field(/^POST NOM(?:\s+|$)/);
  const firstName = given.value;
  const lastName =
    surname.value && (!postName.present || postName.value)
      ? [surname.value, postName.value].filter(Boolean).join(' ')
      : null;
  const confidentNames =
    given.confidence >= 95 &&
    surname.confidence >= 95 &&
    (!postName.present || postName.confidence >= 95);
  const names =
    firstName && lastName && confidentNames
      ? firstName === canonicalName(first) && lastName === canonicalName(last)
        ? 'match'
        : 'mismatch'
      : 'unreadable';
  const expiration = field(
    /^(?:DATE D EXPIRATION|DATE EXPIRATION|DATE DE FIN DE VALIDITE|DATE OF EXPIRY|DATE OF EXPIRATION|EXPIRY DATE|VALID UNTIL|VALABLE JUSQU AU)(?:\s+|$)/,
  );
  let validity =
    type === 'voter_card' && !expiration.present
      ? 'not_required'
      : 'unreadable';
  if (expiration.value && expiration.confidence >= 95) {
    // Only unambiguous numeric dates. Unsupported layouts/month names go to review.
    const parts = expiration.value.match(
      /^(\d{4}) (\d{2}) (\d{2})$|^(\d{2}) (\d{2}) (\d{4})$/,
    );
    if (parts) {
      const year = Number(parts[1] || parts[6]),
        month = Number(parts[2] || parts[5]),
        day = Number(parts[3] || parts[4]);
      const date = new Date(Date.UTC(year, month - 1, day));
      if (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day &&
        year >= 2000 &&
        year <= now.getUTCFullYear() + 30
      )
        validity =
          date.toISOString().slice(0, 10) >= now.toISOString().slice(0, 10)
            ? 'valid'
            : 'expired';
    }
  }
  const ocr =
    document === 'consistent' &&
    confidentNames &&
    ['valid', 'not_required'].includes(validity)
      ? 'confident'
      : 'uncertain';
  return {
    document,
    names,
    validity,
    ocr,
    extracted: { firstName, lastName, expiration: expiration.value },
    manualReviewRequired: true,
  };
}

export function publicAwsSession(
  row: {
    id: string;
    kycId: string;
    state: AwsKycState;
    errorCode?: string | null;
    expiresAt: Date;
  },
  status = 'pending',
) {
  return {
    id: row.id,
    kycId: row.kycId,
    state: row.state,
    status,
    expiresAt: row.expiresAt,
    errorCode: row.errorCode ?? null,
    manualReviewRequired: status === 'pending' && row.state === 'review',
    nextAction:
      status === 'approved'
        ? 'done'
        : status === 'rejected' || row.state === 'failed'
          ? 'retry'
          : row.state === 'ready'
            ? 'capture_liveness'
            : row.state === 'review'
              ? 'wait_review'
              : 'wait',
  };
}
