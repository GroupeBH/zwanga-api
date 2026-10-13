import { ConfigService } from '@nestjs/config';
import {
  awsKycConfig,
  awsKycAvailability,
  awsKycDecision,
  identityHash,
  inspectDocument,
  publicAwsSession,
} from './aws-kyc.policy';

describe('AWS KYC conservative document policy', () => {
  const lines = (values: string[]) =>
    values.map((text) => ({ text, confidence: 99 }));
  const id = [
    'République démocratique du Congo',
    'Carte d’électeur',
    'Prénom: Émile',
    'Nom: Mbala',
  ];
  it('reports preparation safely without weakening configuration validation', () => {
    expect(awsKycAvailability(new ConfigService({}))).toEqual({ enabled: false, unavailableCode: 'AWS_KYC_DISABLED' });
    const invalid = new ConfigService({ AWS_KYC_ENABLED: 'true', AWS_KYC_LIVENESS_ROLE_ARN: 'private-config-value' });
    expect(awsKycAvailability(invalid)).toEqual({ enabled: false, unavailableCode: 'AWS_KYC_CONFIGURATION_REQUIRED' });
    expect(() => awsKycConfig(invalid)).toThrow();
    const configured = new ConfigService({ AWS_KYC_ENABLED: 'true', AWS_S3_BUCKET_NAME: 'private', AWS_KYC_LIVENESS_ROLE_ARN: 'arn:aws:iam::123456789012:role/kyc' });
    expect(awsKycAvailability(configured)).toEqual({ enabled: true, unavailableCode: null });
    expect(JSON.stringify(awsKycAvailability(invalid))).not.toContain('private-config-value');
  });
  it('defaults to disabled and rejects unsupported region/public storage', () => {
    expect(awsKycConfig(new ConfigService({}))).toBeNull();
    expect(() =>
      awsKycConfig(
        new ConfigService({
          AWS_KYC_ENABLED: 'true',
          AWS_KYC_REGION: 'eu-central-1',
        }),
      ),
    ).toThrow();
  });
  it('allows taking over a pending Didit dossier only for an explicit AWS cutover', () => {
    const configured = { AWS_KYC_ENABLED: 'true', AWS_S3_BUCKET_NAME: 'private',
      AWS_KYC_LIVENESS_ROLE_ARN: 'arn:aws:iam::123456789012:role/kyc' };
    expect(awsKycConfig(new ConfigService(configured))?.replacePendingDidit).toBe(false);
    expect(awsKycConfig(new ConfigService({ ...configured, KYC_PROVIDER: 'didit' }))?.replacePendingDidit).toBe(false);
    expect(awsKycConfig(new ConfigService({ ...configured, KYC_PROVIDER: 'aws' }))?.replacePendingDidit).toBe(true);
  });
  it('accepts confident labeled names with accents as eligible for automatic review', () => {
    expect(inspectDocument(lines(id), 'voter_card', 'Emile', 'MBALA')).toEqual(
      expect.objectContaining({
        document: 'consistent',
        names: 'match',
        manualReviewRequired: false,
      }),
    );
    expect(identityHash('Émile', 'Mbala')).toBe(
      identityHash('emile', ' mbala '),
    );
  });
  it('requires every independent check before automatic approval', () => {
    const checks = {
      document: 'consistent',
      names: 'match',
      validity: 'valid',
      ocr: 'confident',
      liveness: 'passed',
      face: 'passed',
    };
    expect(awsKycDecision(checks)).toEqual({ mode: 'automatic', reasons: [] });
    for (const key of Object.keys(checks)) {
      expect(awsKycDecision({ ...checks, [key]: 'uncertain' }).mode).toBe(
        'manual_review',
      );
      const missing = { ...checks };
      delete missing[key];
      expect(awsKycDecision(missing).mode).toBe('manual_review');
    }
  });
  it('does not approve through a low-confidence or duplicate name field', () => {
    const low = lines(id);
    low[2].confidence = 94;
    expect(
      inspectDocument(low, 'voter_card', 'Emile', 'Mbala').manualReviewRequired,
    ).toBe(true);
    const duplicate = [
      ...lines(id),
      { text: 'Nom: Someone else', confidence: 25 },
    ];
    expect(
      inspectDocument(duplicate, 'voter_card', 'Emile', 'Mbala')
        .manualReviewRequired,
    ).toBe(true);
  });
  it('does not ignore a post-nom or conflicting document labels', () => {
    expect(
      inspectDocument(
        lines([...id, 'Post-nom: Test']),
        'voter_card',
        'Emile',
        'Mbala Test',
      ).names,
    ).toBe('match');
    expect(
      inspectDocument(
        lines([...id, 'Post-nom: Test']),
        'voter_card',
        'Emile',
        'Mbala',
      ).names,
    ).toBe('mismatch');
    expect(
      inspectDocument(
        lines([...id, 'Passeport']),
        'voter_card',
        'Emile',
        'Mbala',
      ).document,
    ).toBe('unrecognized');
  });
  it.each(['passport', 'driving_license'] as const)(
    'requires a valid confident expiration on %s',
    (type) => {
      const document = [
        id[0],
        type === 'passport' ? 'Passeport' : 'Permis de conduire',
        ...id.slice(2),
      ];
      const now = new Date('2026-10-11T10:00:00Z');
      expect(
        inspectDocument(lines(document), type, 'Emile', 'Mbala', now).validity,
      ).toBe('unreadable');
      for (const [date, validity] of [
        ['11/10/2026', 'valid'],
        ['10/10/2026', 'expired'],
        ['2030-01-01', 'valid'],
        ['31/02/2030', 'unreadable'],
        ['01/02/30', 'unreadable'],
      ]) {
        const result = inspectDocument(
          lines([...document, `Date d’expiration: ${date}`]),
          type,
          'Emile',
          'Mbala',
          now,
        );
        expect(result.validity).toBe(validity);
        expect(result.manualReviewRequired).toBe(validity !== 'valid');
      }
    },
  );
  it('does not mistake the Republic of Congo or a different type for an RDC document', () => {
    expect(
      inspectDocument(
        lines(['République du Congo', ...id.slice(1)]),
        'voter_card',
        'Emile',
        'Mbala',
      ).document,
    ).toBe('unrecognized');
    expect(
      inspectDocument(lines(id), 'passport', 'Emile', 'Mbala').document,
    ).toBe('unrecognized');
  });
  it('does not match a substring, alias, arbitrary paragraph or ambiguous OCR', () => {
    expect(inspectDocument(lines(id), 'voter_card', 'Em', 'Mbala').names).toBe(
      'mismatch',
    );
    expect(
      inspectDocument(
        lines(['Emile Mbala', ...id.slice(0, 2)]),
        'voter_card',
        'Emile',
        'Mbala',
      ).names,
    ).toBe('unreadable');
    expect(
      inspectDocument(
        lines([...id, 'Nom: Autre']),
        'voter_card',
        'Emile',
        'Mbala',
      ).names,
    ).toBe('unreadable');
    expect(
      inspectDocument(
        id.map((text) => ({ text, confidence: 30 })),
        'voter_card',
        'Emile',
        'Mbala',
      ).names,
    ).toBe('unreadable');
  });
  it('exposes no keys, scores, OCR or expected names to the phone', () => {
    const publicValue = publicAwsSession({
      id: 'id',
      kycId: 'kyc',
      state: 'review',
      expiresAt: new Date(),
      checks: { confidence: 99 },
      objectKey: 'private',
    } as any);
    expect(publicValue.nextAction).toBe('wait_review');
    expect(publicValue).not.toHaveProperty('checks');
    expect(publicValue).not.toHaveProperty('objectKey');
  });
  it('prioritizes the final administrative decision over the worker state', () => {
    const row = {
      id: 'id',
      kycId: 'kyc',
      state: 'review' as const,
      expiresAt: new Date(),
    };
    expect(publicAwsSession(row, 'rejected').nextAction).toBe('retry');
    expect(publicAwsSession(row, 'approved').nextAction).toBe('done');
  });
});
