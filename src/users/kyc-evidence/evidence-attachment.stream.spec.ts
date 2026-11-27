import { Readable } from 'stream';
import { createHash } from 'crypto';
import { checkedAttachment } from './evidence-attachment.stream';
import {
  evidenceAttachmentKey,
  ownsEvidenceObject,
  parseEvidence,
} from './kyc-evidence.manifest';
import { archiveObjectKey } from './kyc-evidence.policy';

describe('bounded original attachment streaming', () => {
  const drain = async (body: Readable) => {
    for await (const _ of body) {
      /* consume without buffering */
    }
  };
  it('validates split ZIP magic, byte count and SHA-256 without retaining video content', async () => {
    const bytes = Buffer.from('PK\x03\x04-synthetic');
    const checked = checkedAttachment(
      Readable.from([bytes.subarray(0, 1), bytes.subarray(1)]),
      'original_files',
      bytes.length,
    );
    await drain(checked.body);
    expect(checked.digest()).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });
  it.each([-1, 0, 128 * 1024 * 1024 + 1, 1.5])(
    'rejects invalid size %s before upload',
    (size) => {
      expect(() =>
        checkedAttachment(Readable.from([]), 'original_files', size),
      ).toThrow('INVALID_ATTACHMENT_SIZE');
    },
  );
  it.each([2, 30])(
    'rejects a short/oversized actual stream against declared %s bytes',
    async (size) => {
      const source = Readable.from([Buffer.from('%PDF-test')]);
      await expect(
        drain(checkedAttachment(source, 'report', size).body),
      ).rejects.toThrow('ATTACHMENT_SIZE_MISMATCH');
      expect(source.destroyed).toBe(true);
    },
  );
  it('rejects HTML masquerading as PDF and corrupted stored checksums', async () => {
    await expect(
      drain(
        checkedAttachment(Readable.from([Buffer.from('<html>')]), 'report', 6)
          .body,
      ),
    ).rejects.toThrow('ATTACHMENT_TYPE_MISMATCH');
    await expect(
      drain(
        checkedAttachment(
          Readable.from([Buffer.from('%PDF-a')]),
          'report',
          6,
          '0'.repeat(64),
        ).body,
      ),
    ).rejects.toThrow('ATTACHMENT_INTEGRITY_FAILED');
  });
  it('owns only fixed attachments under the exact recorded lease; validates duplicate metadata', () => {
    const key = archiveObjectKey(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
    expect(
      ownsEvidenceObject(key, evidenceAttachmentKey(key, 'original_files')),
    ).toBe(true);
    expect(
      ownsEvidenceObject(key, key.replace('.json', '/unexpected.zip')),
    ).toBe(false);
    const attachment = {
      kind: 'report',
      mimeType: 'application/pdf',
      size: 7,
      sha256: '0'.repeat(64),
    };
    expect(() =>
      parseEvidence(
        {
          version: 1,
          sessionId: 's',
          capturedAt: 'now',
          details: {},
          files: [],
          missing: [],
          attachments: [attachment, attachment],
        },
        key,
      ),
    ).toThrow('ARCHIVE_NOT_READABLE');
  });
});
