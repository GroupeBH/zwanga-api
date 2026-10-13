// Only fixed categories may reach operational logs. SDK errors can contain
// request payloads, credentials, document metadata or network URLs.
export function awsKycFailureCode(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : null;
  switch (name) {
    case 'AccessDenied':
    case 'AccessDeniedException': return 'ACCESS_DENIED';
    case 'CredentialsProviderError':
    case 'ExpiredToken':
    case 'ExpiredTokenException':
    case 'InvalidClientTokenId':
    case 'UnrecognizedClientException': return 'CREDENTIALS_UNAVAILABLE';
    case 'ThrottlingException':
    case 'ProvisionedThroughputExceededException':
    case 'LimitExceededException': return 'AWS_LIMIT';
    case 'ResourceNotFoundException':
    case 'NoSuchBucket':
    case 'NoSuchKey': return 'RESOURCE_UNAVAILABLE';
    case 'AbortError':
    case 'TimeoutError': return 'TIMEOUT';
    case 'InvalidParameterException': return 'INVALID_PARAMETERS';
    default: return 'PROCESSING_UNAVAILABLE';
  }
}
