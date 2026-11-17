import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FileUploadService } from '../../common/services/file-upload.service';
import {
  publicDriverCredits,
  publicPhotoUrl,
  type PublicDriverCard,
} from './public-driver.model';

type PublicDriverRow = Omit<PublicDriverCard, 'driverCategory' | 'credits'> & {
  driverCategory: string | null;
  credits: unknown;
};

/** One read-only snapshot; UUID is already unique, no new QR secret or migration. */
export const PUBLIC_DRIVER_QUERY = `
SELECT u.id, u."firstName", u."lastName", u."profilePicture", u."driverCategory", u."isPhoneVerified",
  (SELECT COUNT(*)::int FROM trips t WHERE t."driverId"=u.id AND t.status='completed') AS "completedTrips",
  (SELECT ROUND(AVG(r.rating),1)::float FROM ratings r WHERE r."ratedUserId"=u.id) AS "averageRating",
  (SELECT COUNT(*)::int FROM ratings r WHERE r."ratedUserId"=u.id) AS "totalRatings",
  COALESCE((SELECT jsonb_agg(v) FROM (
    SELECT type, brand, model, color, "licensePlate" FROM vehicles
    WHERE "ownerId"=u.id AND "isActive"=true ORDER BY "createdAt",id LIMIT 12
  ) v),'[]'::jsonb) AS vehicles,
  COALESCE((SELECT jsonb_agg(c) FROM (
    SELECT DISTINCT "assetKind", status FROM asset_credits
    WHERE "driverId"=u.id AND status IN ('active','settled')
    ORDER BY "assetKind",status
  ) c),'[]'::jsonb) AS credits
FROM users u
WHERE u.id=$1 AND u.role='driver' AND u."isActive"=true AND u.status='active'`;

@Injectable()
export class PublicDriverService {
  constructor(
    private readonly db: DataSource,
    private readonly files: FileUploadService,
  ) {}

  async getCard(id: string): Promise<PublicDriverCard> {
    const [row] = await this.db.query<PublicDriverRow[]>(PUBLIC_DRIVER_QUERY, [
      id,
    ]);
    if (!row) throw new NotFoundException('Fiche conducteur indisponible.');
    // A missing photo must not prevent identification. Never fall back to a raw S3 key.
    const photo = await this.files
      .getPresignedUrlIfS3Key(row.profilePicture)
      .catch(() => null);
    return {
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      profilePicture: publicPhotoUrl(photo),
      driverCategory:
        row.driverCategory === 'private' ||
        row.driverCategory === 'transport' ||
        row.driverCategory === 'intercity'
          ? row.driverCategory
          : null,
      isPhoneVerified: row.isPhoneVerified === true,
      completedTrips: Number(row.completedTrips),
      averageRating:
        row.averageRating === null ? null : Number(row.averageRating),
      totalRatings: Number(row.totalRatings),
      vehicles: (row.vehicles ?? []).map((v) => ({
        type: v.type,
        brand: v.brand,
        model: v.model,
        color: v.color,
        licensePlate: v.licensePlate,
      })),
      credits: publicDriverCredits(row.credits),
    };
  }
}
