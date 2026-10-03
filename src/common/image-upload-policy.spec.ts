import sharp = require('sharp');
import { normalizeUploadedImage, IMAGE_UPLOAD_OPTIONS } from './image-upload-policy';
import { signLocalUpload, verifyLocalUpload, isLocalUploadKey } from './local-upload-policy';

describe('Upload security boundaries', () => {
  it.each(['<html><script>alert(1)</script>', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'not an image'])(
    'rejects disguised non-raster data', async content => {
      await expect(normalizeUploadedImage(Buffer.from(content))).rejects.toThrow();
    });
  it('decodes a real image and chooses the stored extension/type', async () => {
    const input = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#fff' } }).png().toBuffer();
    const result = await normalizeUploadedImage(input);
    expect(result.originalname).toBe('image.jpg');
    expect(result.mimetype).toBe('image/jpeg');
    expect((await sharp(result.buffer).metadata()).format).toBe('jpeg');
  });
  it('rejects oversized and truncated input before storing anything', async () => {
    await expect(normalizeUploadedImage(Buffer.alloc(IMAGE_UPLOAD_OPTIONS.limits.fileSize + 1))).rejects.toThrow();
    await expect(normalizeUploadedImage(Buffer.from([0xff, 0xd8, 0xff]))).rejects.toThrow();
  });
  it('binds local KYC signatures to the file and expiration', () => {
    const key = 'kyc/00000000-0000-4000-8000-000000000001.jpg';
    const expires = Math.floor(Date.now() / 1000) + 900;
    const signature = signLocalUpload(key, expires, 'test-only-secret');
    expect(verifyLocalUpload(key, String(expires), signature, 'test-only-secret')).toBe(true);
    expect(verifyLocalUpload(key.replace('001', '002'), String(expires), signature, 'test-only-secret')).toBe(false);
    expect(verifyLocalUpload(key, String(expires - 1000), signature, 'test-only-secret')).toBe(false);
    expect(verifyLocalUpload(key, String(expires), '', 'test-only-secret')).toBe(false);
    expect(isLocalUploadKey('../.env')).toBe(false);
    expect(isLocalUploadKey('profiles/x.html')).toBe(false);
  });
});
