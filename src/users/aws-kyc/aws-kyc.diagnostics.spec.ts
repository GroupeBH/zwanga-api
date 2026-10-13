import { awsKycFailureCode } from './aws-kyc.diagnostics';

describe('AWS KYC operational diagnostics', () => {
  it.each([
    ['AccessDeniedException', 'ACCESS_DENIED'],
    ['CredentialsProviderError', 'CREDENTIALS_UNAVAILABLE'],
    ['ThrottlingException', 'AWS_LIMIT'],
    ['NoSuchBucket', 'RESOURCE_UNAVAILABLE'],
    ['TimeoutError', 'TIMEOUT'],
  ])('reports only a fixed category for %s', (name, code) => {
    expect(awsKycFailureCode({ name, message: 'sensitive', request: { credentials: 'secret' } })).toBe(code);
  });
  it('never copies an unknown error name, message or payload into the log', () => {
    for (const value of [null, 'secret', { name: 'secret', message: 'private document' }, new Error('token')])
      expect(awsKycFailureCode(value)).toBe('PROCESSING_UNAVAILABLE');
  });
});
