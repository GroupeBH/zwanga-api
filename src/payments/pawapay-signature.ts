import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';

const SIGNED_COMPONENTS = [
  '@method',
  '@authority',
  '@path',
  'signature-date',
  'content-digest',
  'content-type',
] as const;
const ACCEPTED_ALGORITHMS = new Set([
  'ecdsa-p256-sha256',
  'rsa-v1_5-sha256',
  'rsa-pss-sha512',
  'ecdsa-p384-sha384',
]);

type HeaderMap = Record<string, string | string[] | undefined>;

function header(headers: HeaderMap, name: string): string {
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}

function signatureBase(
  components: string[],
  params: string,
  method: string,
  url: URL,
  headers: HeaderMap,
): string {
  const lines = components.map((component) => {
    let value: string;
    switch (component) {
      case '@method':
        value = method.toUpperCase();
        break;
      case '@authority':
        value = url.host;
        break;
      case '@path':
        value = url.pathname;
        break;
      case 'signature-date':
      case 'content-digest':
      case 'content-type':
        value = header(headers, component);
        break;
      default:
        throw new UnauthorizedException(
          'Composant de signature PawaPay inconnu',
        );
    }
    if (!value)
      throw new UnauthorizedException('En-tête de signature PawaPay manquant');
    return `"${component}": ${value}`;
  });
  return [...lines, `"@signature-params": ${params}`].join('\n');
}

export function contentDigest(body: Buffer): string {
  return `sha-512=:${createHash('sha512').update(body).digest('base64')}:`;
}

export function signPawaPayRequest(
  url: string,
  body: string,
  privateKeyPem: string,
  keyId: string,
): HeaderMap {
  if (!keyId || !/^[\w:.-]+$/.test(keyId))
    throw new BadRequestException('Identifiant de clé PawaPay invalide');
  const key = createPrivateKey(privateKeyPem);
  if (
    key.asymmetricKeyType !== 'ec' ||
    key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new BadRequestException(
      'La clé de signature PawaPay doit être EC P-256',
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const params = `(${SIGNED_COMPONENTS.map((part) => `"${part}"`).join(' ')});alg="ecdsa-p256-sha256";keyid="${keyId}";created=${now};expires=${now + 60}`;
  const headers = {
    'content-type': 'application/json',
    'content-digest': contentDigest(Buffer.from(body, 'utf8')),
    'signature-date': new Date().toISOString(),
  };
  const base = signatureBase(
    [...SIGNED_COMPONENTS],
    params,
    'POST',
    new URL(url),
    headers,
  );
  const signature = sign('sha256', Buffer.from(base), key).toString('base64');
  return {
    'Content-Type': headers['content-type'],
    'Content-Digest': headers['content-digest'],
    'Signature-Date': headers['signature-date'],
    'Signature-Input': `sig-pp=${params}`,
    Signature: `sig-pp=:${signature}:`,
  };
}

export function verifyPawaPayCallback(input: {
  method: string;
  url: string;
  headers: HeaderMap;
  body: Buffer;
  publicKeyPem: string;
  now?: number;
}): string {
  const digestHeader = header(input.headers, 'content-digest');
  const digestMatch = /^sha-(256|512)=:([A-Za-z0-9+/]+={0,2}):$/.exec(
    digestHeader,
  );
  if (!digestMatch)
    throw new UnauthorizedException('Digest PawaPay manquant ou invalide');
  const expected = Buffer.from(digestMatch[2], 'base64');
  const actual = createHash(`sha${digestMatch[1]}`).update(input.body).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new UnauthorizedException('Corps du callback PawaPay modifié');
  }
  const signatureInput = header(input.headers, 'signature-input');
  const matched =
    /(?:^|,\s*)sig-pp=(\((?:"[a-z@-]+"\s*)+\)(?:;[a-z]+=(?:"[\w:.-]+"|\d+))*)/.exec(
      signatureInput,
    );
  if (!matched) throw new UnauthorizedException('Signature PawaPay manquante');
  const params = matched[1];
  const components = [...params.matchAll(/"([a-z@-]+)"(?=\s|\))/g)].map(
    (match) => match[1],
  );
  if (
    components.length < SIGNED_COMPONENTS.length ||
    SIGNED_COMPONENTS.some((name) => !components.includes(name))
  ) {
    throw new UnauthorizedException('Signature PawaPay incomplète');
  }
  const alg = /;alg="([\w-]+)"/.exec(params)?.[1];
  const keyId = /;keyid="([\w:.-]+)"/.exec(params)?.[1];
  const created = Number(/;created=(\d+)/.exec(params)?.[1]);
  const expires = Number(/;expires=(\d+)/.exec(params)?.[1]);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (
    !alg ||
    !ACCEPTED_ALGORITHMS.has(alg) ||
    !keyId ||
    !created ||
    !expires ||
    created > now + 60 ||
    created < now - 300 ||
    expires < now ||
    expires > created + 300
  ) {
    throw new UnauthorizedException('Signature PawaPay expirée ou invalide');
  }
  const signatureValue = /(?:^|,\s*)sig-pp=:([A-Za-z0-9+/]+={0,2}):/.exec(
    header(input.headers, 'signature'),
  )?.[1];
  if (!signatureValue)
    throw new UnauthorizedException('Signature PawaPay manquante');
  const base = signatureBase(
    components,
    params,
    input.method,
    new URL(input.url),
    input.headers,
  );
  const key = createPublicKey(input.publicKeyPem);
  const cryptoAlgorithm =
    alg === 'rsa-pss-sha512'
      ? 'sha512'
      : alg === 'ecdsa-p384-sha384'
        ? 'sha384'
        : 'sha256';
  const options =
    alg === 'rsa-pss-sha512'
      ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 }
      : key;
  if (
    !verify(
      cryptoAlgorithm,
      Buffer.from(base),
      options,
      Buffer.from(signatureValue, 'base64'),
    )
  ) {
    throw new UnauthorizedException('Signature du callback PawaPay invalide');
  }
  return keyId;
}

export function pawaPayCallbackKeyId(headers: HeaderMap): string {
  const value = header(headers, 'signature-input');
  const keyId = /(?:^|,\s*)sig-pp=\([^)]*\)[^,]*;keyid="([\w:.-]+)"/.exec(
    value,
  )?.[1];
  if (!keyId)
    throw new UnauthorizedException('Clé de signature PawaPay manquante');
  return keyId;
}
