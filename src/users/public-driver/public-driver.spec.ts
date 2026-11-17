import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { IpThrottlerGuard } from '../../common/guards/throttler.guard';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { FileUploadService } from '../../common/services/file-upload.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { UsersController } from '../users.controller';
import {
  PublicDriverService,
  PUBLIC_DRIVER_QUERY,
} from './public-driver.service';
import { PublicDriverController } from './public-driver.controller';
import { publicDriverCredits, publicPhotoUrl } from './public-driver.model';
import { renderDriverCard } from './public-driver.html';

const id = '11111111-1111-4111-8111-111111111111';
const row = () => ({
  id,
  firstName: 'Conducteur',
  lastName: 'Démo',
  profilePicture: 'profiles/test.jpg',
  driverCategory: 'transport',
  isPhoneVerified: true,
  completedTrips: 12,
  averageRating: 4.5,
  totalRatings: 3,
  vehicles: [
    {
      type: 'car',
      brand: 'Voiture',
      model: 'Démo',
      color: 'Bleu',
      licensePlate: 'TEST',
      privateDocument: 'secret-document',
    },
  ],
  credits: [
    {
      assetKind: 'phone',
      status: 'active',
      principalMinor: 123456,
      dueMinor: 999,
      label: 'secret-contract',
    },
  ],
  phone: 'private-phone',
  email: 'private-email',
  password: 'private-password',
  fcmToken: 'private-token',
});
function fixture() {
  const db = { query: jest.fn().mockResolvedValue([row()]) };
  const files = {
    getPresignedUrlIfS3Key: jest
      .fn()
      .mockResolvedValue('https://example.invalid/photo.jpg'),
  };
  return {
    db,
    files,
    service: new PublicDriverService(db as any, files as any),
  };
}

describe('public driver allowlist', () => {
  it('only publishes distinct active/settled asset kinds, never terms, IDs or money', () => {
    const input = [
      'offered',
      'accepted',
      'active',
      'settled',
      'declined',
      'cancelled',
      'overdue',
    ].map((status) => ({
      id: 'private',
      assetKind: 'vehicle',
      status,
      principalMinor: 100000,
      paidMinor: 20,
      dueMinor: 50,
      terms: 'private',
    }));
    expect(
      publicDriverCredits([
        ...input,
        input[2],
        { assetKind: 'unknown', status: 'active' },
        null,
      ]),
    ).toEqual([
      { assetKind: 'vehicle', status: 'active' },
      { assetKind: 'vehicle', status: 'settled' },
    ]);
    expect(publicDriverCredits(undefined)).toEqual([]);
  });
  it('covers all six asset kinds without generic free-text labels', () => {
    const kinds = [
      'phone',
      'helmet',
      'gps_tracker',
      'delivery_equipment',
      'equipment',
      'vehicle',
    ];
    expect(
      publicDriverCredits(
        kinds.map((assetKind) => ({ assetKind, status: 'active' })),
      ),
    ).toHaveLength(6);
  });
  it('selects a parameterized, active-driver snapshot with only two credit columns', async () => {
    const f = fixture();
    const card = await f.service.getCard(id);
    expect(f.db.query).toHaveBeenCalledWith(PUBLIC_DRIVER_QUERY, [id]);
    expect(PUBLIC_DRIVER_QUERY).toContain('u.id=$1');
    for (const guard of [
      "u.role='driver'",
      'u."isActive"=true',
      "u.status='active'",
    ])
      expect(PUBLIC_DRIVER_QUERY).toContain(guard);
    expect(PUBLIC_DRIVER_QUERY).toContain(
      'SELECT DISTINCT "assetKind", status FROM asset_credits',
    );
    expect(PUBLIC_DRIVER_QUERY).not.toMatch(
      /SELECT\s+\*|principalMinor|paidMinor|dueMinor|terms|password|fcmToken/,
    );
    expect(Object.keys(card).sort()).toEqual(
      [
        'id',
        'firstName',
        'lastName',
        'profilePicture',
        'driverCategory',
        'isPhoneVerified',
        'completedTrips',
        'averageRating',
        'totalRatings',
        'vehicles',
        'credits',
      ].sort(),
    );
    expect(Object.keys(card.vehicles[0]).sort()).toEqual(
      ['type', 'brand', 'model', 'color', 'licensePlate'].sort(),
    );
    expect(card.credits).toEqual([{ assetKind: 'phone', status: 'active' }]);
    expect(JSON.stringify(card)).not.toMatch(
      /private-|secret-|principalMinor|dueMinor/,
    );
  });
  it('rejects missing, non-driver or inactive rows without issuing a photo URL', async () => {
    const f = fixture();
    f.db.query.mockResolvedValue([]);
    await expect(f.service.getCard(id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(f.files.getPresignedUrlIfS3Key).not.toHaveBeenCalled();
  });
  it('reads each scan again so a settled credit does not remain active', async () => {
    const f = fixture();
    expect((await f.service.getCard(id)).credits[0].status).toBe('active');
    f.db.query.mockResolvedValue([
      { ...row(), credits: [{ assetKind: 'phone', status: 'settled' }] },
    ]);
    expect((await f.service.getCard(id)).credits[0].status).toBe('settled');
    expect(f.db.query).toHaveBeenCalledTimes(2);
  });
  it('does not turn database errors into a false no-credit claim', async () => {
    const f = fixture();
    f.db.query.mockRejectedValue(new Error('database unavailable'));
    await expect(f.service.getCard(id)).rejects.toThrow('database unavailable');
  });
  it('a photo failure leaves the rest accessible without a raw file-key fallback', async () => {
    const f = fixture();
    f.files.getPresignedUrlIfS3Key.mockRejectedValue(
      new Error('storage unavailable'),
    );
    expect((await f.service.getCard(id)).profilePicture).toBeNull();
    for (const url of [
      'javascript:alert(1)',
      'data:image/svg+xml,bad',
      'http://example.invalid/x',
      'https://u:p@example.invalid/x',
      'kyc/private',
    ])
      expect(publicPhotoUrl(url)).toBeNull();
  });
  it('escapes stored text and rejects script/photo URL injection in the page', async () => {
    const f = fixture();
    const card = await f.service.getCard(id);
    const html = renderDriverCard({
      ...card,
      firstName: '<script>alert(1)</script>',
      profilePicture: 'javascript:alert(1)',
      vehicles: [
        { ...card.vehicles[0], model: '<img src=x onerror=alert(1)>' },
      ],
    });
    expect(html).not.toMatch(/<script|<img src=x|javascript:/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain('En cours');
    expect(html).not.toContain('123456');
  });
});

describe('anonymous driver QR HTTP integration (database and storage mocked)', () => {
  let app: INestApplication;
  let f: ReturnType<typeof fixture>;
  beforeEach(async () => {
    f = fixture();
    const module = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 500 }]),
      ],
      controllers: [PublicDriverController],
      providers: [
        PublicDriverService,
        IpThrottlerGuard,
        { provide: DataSource, useValue: f.db },
        { provide: FileUploadService, useValue: f.files },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalGuards(
      new JwtAuthGuard(module.get(Reflector)),
      module.get(IpThrottlerGuard),
    );
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
  });
  it('serves JSON and a styled browser page without JWT, with no-store/noindex', async () => {
    const json = await request(app.getHttpServer())
      .get(`/api/v1/public/drivers/${id}`)
      .expect(200);
    expect(json.headers['cache-control']).toBe('no-store');
    expect(json.body.credits).toEqual([
      { assetKind: 'phone', status: 'active' },
    ]);
    const page = await request(app.getHttpServer())
      .get(`/api/v1/public/drivers/${id}/card`)
      .expect(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-robots-tag']).toContain('noindex');
    expect(page.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.text).toContain('Biens à crédit chez Zwanga');
    expect(page.text).not.toMatch(/private-|secret-|principalMinor|dueMinor/);
  });
  it('invalid UUIDs are rejected before SQL', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/public/drivers/not-a-uuid')
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/public/drivers/not-a-uuid/card')
      .expect(404);
    expect(f.db.query).not.toHaveBeenCalled();
  });
  it('inactive driver and backend failure never render stale information', async () => {
    f.db.query.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get(`/api/v1/public/drivers/${id}`)
      .expect(404);
    let page = await request(app.getHttpServer())
      .get(`/api/v1/public/drivers/${id}/card`)
      .expect(404);
    expect(page.text).toContain('Fiche indisponible');
    f.db.query.mockRejectedValue(new Error('secret database host'));
    page = await request(app.getHttpServer())
      .get(`/api/v1/public/drivers/${id}/card`)
      .expect(503);
    expect(page.text).not.toMatch(/secret database|Aucun bien à crédit/);
    expect(page.headers['cache-control']).toBe('no-store');
  });
  it('limits anonymous repeated scans', async () => {
    for (let i = 0; i < 30; i++)
      await request(app.getHttpServer())
        .get(`/api/v1/public/drivers/${id}`)
        .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/public/drivers/${id}`)
      .expect(429);
  });
  it('does not make the existing authenticated user profile endpoint public', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, UsersController)).not.toBe(true);
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        UsersController.prototype.getPublicProfile,
      ),
    ).not.toBe(true);
  });
});
