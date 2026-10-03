import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import sharp = require('sharp');

export const IMAGE_UPLOAD_OPTIONS = { limits: {
  fileSize: 5 * 1024 * 1024, files: 3, fields: 32, parts: 35, fieldSize: 64 * 1024,
} };
let activeDecoders = 0;

export async function normalizeUploadedImage(buffer: Buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > IMAGE_UPLOAD_OPTIONS.limits.fileSize) {
    throw new BadRequestException('Choisissez une image de moins de 5 Mo.');
  }
  if (activeDecoders >= 4) throw new ServiceUnavailableException('Envoi occupé. Réessayez dans un instant.');
  const isJpeg = buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isWebp = buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  if (!isJpeg && !isPng && !isWebp) throw new BadRequestException('Le fichier doit être une photo JPEG, PNG ou WebP.');
  activeDecoders++;
  try {
    const input = sharp(buffer, { failOn: 'warning', limitInputPixels: 25_000_000 });
    const metadata = await input.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) {
      throw new Error('Unsupported image');
    }
    // Decode completely, remove metadata (including GPS), and derive the stored type ourselves.
    const output = await input.rotate().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 }).timeout({ seconds: 10 }).toBuffer();
    return { buffer: output, size: output.length, mimetype: 'image/jpeg', originalname: 'image.jpg' };
  } catch {
    throw new BadRequestException('Image invalide. Choisissez une photo JPEG, PNG ou WebP valide.');
  } finally { activeDecoders--; }
}
