import { createHash } from 'crypto';
import { Readable } from 'stream';
import { ATTACHMENTS, AttachmentKind } from './didit-archive.policy';

// No ZIP extraction or full-video buffering. The hash is finalized only once
// the entire stream has been consumed successfully by S3/the admin download.
export function checkedAttachment(
  source: Readable,
  kind: AttachmentKind,
  size: number,
  expectedHash?: string,
) {
  const policy = ATTACHMENTS[kind];
  if (
    !policy ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > policy.maxBytes
  )
    throw new Error('INVALID_ATTACHMENT_SIZE');
  let digest: string | undefined;
  const body = Readable.from(
    (async function* () {
      let count = 0,
        prefix = Buffer.alloc(0),
        signatureChecked = false;
      const hash = createHash('sha256');
      try {
        for await (const data of source) {
          const chunk = Buffer.from(data);
          count += chunk.length;
          if (count > size) throw new Error('ATTACHMENT_SIZE_MISMATCH');
          hash.update(chunk);
          if (!signatureChecked) {
            prefix = Buffer.concat([
              prefix,
              chunk.subarray(0, Math.max(0, 5 - prefix.length)),
            ]);
            if (prefix.length >= 5 || count === size) {
              if (
                (kind === 'original_files' &&
                  !['504b0304', '504b0506', '504b0708'].includes(
                    prefix.subarray(0, 4).toString('hex'),
                  )) ||
                (kind === 'report' &&
                  prefix.subarray(0, 5).toString() !== '%PDF-')
              )
                throw new Error('ATTACHMENT_TYPE_MISMATCH');
              signatureChecked = true;
            }
          }
          yield chunk;
        }
        if (count !== size) throw new Error('ATTACHMENT_SIZE_MISMATCH');
        digest = hash.digest('hex');
        if (expectedHash && digest !== expectedHash)
          throw new Error('ATTACHMENT_INTEGRITY_FAILED');
      } finally {
        source.destroy();
      }
    })(),
    { objectMode: false },
  );
  body.once('close', () => source.destroy());
  return {
    body,
    digest: () => {
      if (!digest) throw new Error('ATTACHMENT_INCOMPLETE');
      return digest;
    },
  };
}
