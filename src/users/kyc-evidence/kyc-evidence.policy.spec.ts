import { archiveConfig, extractEvidence } from './kyc-evidence.policy';
import { isPublicMediaAddress, mediaUrl } from './kyc-evidence.transport';

const configuration = {
  DIDIT_KYC_ARCHIVE_ENABLED: 'true',
  DIDIT_KYC_ARCHIVE_RETENTION_DAYS: '30',
  DIDIT_KYC_MEDIA_HOSTS: 'media.didit.test',
  AWS_S3_BUCKET_NAME: 'private-test',
  DIDIT_API_KEY: 'synthetic-key',
};
describe('KYC evidence configuration and minimization', () => {
  it('refuses collection when the application declares a public bucket', () => {
    expect(
      archiveConfig({
        get: (name: string) =>
          name === 'AWS_S3_PUBLIC_BUCKET' ? 'true' : configuration[name],
      } as any),
    ).toBeNull();
  });
  it('is off by default and refuses an unspecified retention period or media hosts', () => {
    for (const key of Object.keys(configuration)) {
      expect(
        archiveConfig({
          get: (name: string) =>
            name === key ? undefined : configuration[name],
        } as any),
      ).toBeNull();
    }
    expect(
      archiveConfig({ get: (name: string) => configuration[name] } as any),
    ).toMatchObject({ days: 30 });
  });
  it('allows explicitly configured zero days as indefinite retention', () => {
    expect(
      archiveConfig({
        get: (name: string) =>
          name === 'DIDIT_KYC_ARCHIVE_RETENTION_DAYS'
            ? '0'
            : configuration[name],
      } as any),
    ).toMatchObject({ days: 0 });
  });
  it.each(['', '   ', null, '-1', '1.5', '3651', 'NaN'])(
    'rejects retention %s',
    (days) => {
      expect(
        archiveConfig({
          get: (name: string) =>
            name === 'DIDIT_KYC_ARCHIVE_RETENTION_DAYS'
              ? days
              : configuration[name],
        } as any),
      ).toBeNull();
    },
  );
  it('reads V3 arrays without archiving raw payloads, face-search matches or other identities', () => {
    const result = extractEvidence(
      {
        session_id: 'session',
        vendor_data: 'user',
        session_kind: 'user',
        status: 'Approved',
        id_verifications: [
          {
            node_id: 'id1',
            front_image: 'https://media.didit.test/front',
            back_image: 'https://media.didit.test/back',
            full_name: 'Example Person',
            document_number: 'SYNTHETIC',
            personal_number: 'unnecessary',
            address: 'unnecessary',
            portrait_image: 'https://media.didit.test/portrait',
            matches: [
              {
                full_name: 'Other Person',
                front_image_url: 'https://media.didit.test/other',
              },
            ],
          },
        ],
        liveness_checks: [
          {
            reference_image: 'https://media.didit.test/selfie',
            score: 99,
            matches: [{ match_image_url: 'https://media.didit.test/other' }],
          },
        ],
        face_matches: [
          {
            source_image: 'https://media.didit.test/other-source',
            target_image: 'https://media.didit.test/selfie',
          },
        ],
        ip_analyses: [{ ip: 'private-info' }],
        metadata: { secret: 'unnecessary' },
      },
      'session',
      'user',
    );
    expect(result.media.map((m) => m.kind)).toEqual([
      'document_front',
      'document_back',
      'selfie',
    ]);
    expect(result.details.documents).toEqual([
      expect.objectContaining({
        full_name: 'Example Person',
        document_number: 'SYNTHETIC',
      }),
    ]);
    expect(JSON.stringify(result.details)).not.toMatch(
      /https:|Other Person|unnecessary|score|private-info/,
    );
  });
  it('uses only the face-match target when the liveness image is missing', () => {
    expect(
      extractEvidence(
        {
          session_id: 's',
          face_matches: [{ source_image: 'wrong', target_image: 'right' }],
        },
        's',
        'u',
      ).media[0].url,
    ).toBe('right');
  });
  it.each([
    { session_id: 'other' },
    { session_id: 's', vendor_data: 'other' },
    { session_id: 's', session_kind: 'business' },
  ])('rejects a mismatched session owner or kind', (payload) => {
    expect(() => extractEvidence(payload, 's', 'u')).toThrow(
      'SESSION_OWNER_MISMATCH',
    );
  });
  it('rejects singular or unbounded V3 report shapes instead of silently truncating', () => {
    expect(() =>
      extractEvidence({ session_id: 's', id_verifications: {} }, 's', 'u'),
    ).toThrow('UNSUPPORTED_DECISION_SHAPE');
    expect(() =>
      extractEvidence(
        { session_id: 's', id_verifications: Array(5).fill({}) },
        's',
        'u',
      ),
    ).toThrow('TOO_MANY_VERIFICATION_STEPS');
  });
});
describe('KYC download boundary', () => {
  it.each([
    'http://media.didit.test/a',
    'https://media.didit.test.evil.test/a',
    'https://media.didit.test@evil.test/a',
    'https://user:pass@media.didit.test/a',
    'https://media.didit.test:8443/a',
    'https://127.0.0.1/a',
    'https://[::1]/a',
    'file:///tmp/test',
  ])('rejects %s', (url) => {
    expect(() => mediaUrl(url, ['media.didit.test'])).toThrow(
      'MEDIA_URL_REJECTED',
    );
  });
  it('allows only an exact configured HTTPS host', () => {
    expect(
      mediaUrl('https://media.didit.test/a?signature=test', [
        'media.didit.test',
      ]).hostname,
    ).toBe('media.didit.test');
  });
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::ffff:127.0.0.1',
  ])('rejects private/reserved address %s', (address) => {
    expect(isPublicMediaAddress(address)).toBe(false);
  });
  it('accepts a public IPv4 address after resolution', () =>
    expect(isPublicMediaAddress('8.8.8.8')).toBe(true));
});
