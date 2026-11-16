import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IsolatedPostgres } from '../../../test/isolated-postgres';
import { FileUploadService } from '../../common/services/file-upload.service';
import { PublicDriverService } from './public-driver.service';
import { PublicDriverController } from './public-driver.controller';

const bin = process.env.DRIVER_QR_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'driver QR: real isolated PostgreSQL + HTTP',
  () => {
    const pg = new IsolatedPostgres(bin!);
    let db: DataSource,
      app: INestApplication,
      driverId: string,
      otherId: string;
    beforeAll(async () => {
      db = await pg.start();
      // Minimal schema fixture matching the queried columns; no application .env.
      await db.query(`CREATE TABLE users(id uuid PRIMARY KEY,"firstName" text,"lastName" text,"profilePicture" text,"driverCategory" text,"isPhoneVerified" boolean,role text,"isDriver" boolean,"isActive" boolean,status text);
      CREATE TABLE trips(id uuid PRIMARY KEY,"driverId" uuid,status text);
      CREATE TABLE ratings(id uuid PRIMARY KEY,"ratedUserId" uuid,rating integer);
      CREATE TABLE vehicles(id uuid PRIMARY KEY,"ownerId" uuid,type text,brand text,model text,color text,"licensePlate" text,"isActive" boolean,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE asset_credits(id uuid PRIMARY KEY,"driverId" uuid,"assetKind" text,status text,"principalMinor" bigint,"dueMinor" bigint);
      CREATE INDEX ON asset_credits("driverId",status);`);
      const module = await Test.createTestingModule({
        controllers: [PublicDriverController],
        providers: [
          PublicDriverService,
          { provide: DataSource, useValue: db },
          {
            provide: FileUploadService,
            useValue: { getPresignedUrlIfS3Key: async () => null },
          },
        ],
      }).compile();
      app = module.createNestApplication({ logger: false });
      app.setGlobalPrefix('api/v1');
      await app.init();
    }, 90000);
    afterAll(async () => {
      await app?.close();
      await pg.stop();
    }, 40000);
    beforeEach(async () => {
      await db.query('TRUNCATE asset_credits,vehicles,ratings,trips,users');
      driverId = randomUUID();
      otherId = randomUUID();
      for (const id of [driverId, otherId])
        await db.query(
          `INSERT INTO users VALUES($1,'Conducteur','Démo',NULL,'transport',true,'driver',true,true,'active')`,
          [id],
        );
      for (const status of [
        'offered',
        'accepted',
        'active',
        'settled',
        'declined',
        'cancelled',
      ])
        await db.query(
          `INSERT INTO asset_credits VALUES($1,$2,'phone',$3,123456789,987654321)`,
          [randomUUID(), driverId, status],
        );
      await db.query(
        `INSERT INTO asset_credits VALUES($1,$2,'vehicle','active',123456789,987654321)`,
        [randomUUID(), otherId],
      );
    });
    const get = () =>
      request(app.getHttpServer()).get(`/api/v1/public/drivers/${driverId}`);
    it('filters actual rows, separates drivers and does not return financial columns', async () => {
      const response = await get().expect(200);
      expect(response.body.credits).toEqual([
        { assetKind: 'phone', status: 'active' },
        { assetKind: 'phone', status: 'settled' },
      ]);
      expect(JSON.stringify(response.body)).not.toMatch(
        /123456789|987654321|principalMinor|dueMinor/,
      );
      expect(response.body.vehicles).toEqual([]);
      expect(response.body.averageRating).toBeNull();
      expect(response.body.completedTrips).toBe(0);
    });
    it.each([
      ['passenger', true, true, 'active'],
      ['admin', true, true, 'active'],
      ['driver', true, false, 'active'],
      ['driver', true, true, 'suspended'],
      ['driver', true, true, 'pending_kyc'],
      ['driver', true, true, 'inactive'],
    ])(
      'hides role=%s, driver=%s, enabled=%s, status=%s',
      async (role, isDriver, active, status) => {
        await db.query(
          'UPDATE users SET role=$2,"isDriver"=$3,"isActive"=$4,status=$5 WHERE id=$1',
          [driverId, role, isDriver, active, status],
        );
        await get().expect(404);
        const page = await request(app.getHttpServer())
          .get(`/api/v1/public/drivers/${driverId}/card`)
          .expect(404);
        expect(page.text).not.toContain('Conducteur Démo');
      },
    );
    it('keeps legacy drivers whose role is driver even if the old boolean is false', async () => {
      await db.query('UPDATE users SET "isDriver"=false WHERE id=$1', [
        driverId,
      ]);
      await get().expect(200);
    });
    it('publishes only active owned vehicles, completed trips and rating aggregates', async () => {
      for (const [owner, active, plate] of [
        [driverId, true, 'PUBLIC'],
        [driverId, false, 'HIDDEN'],
        [otherId, true, 'OTHER'],
      ])
        await db.query(
          `INSERT INTO vehicles(id,"ownerId",type,brand,model,color,"licensePlate","isActive") VALUES($1,$2,'car','Voiture','Démo','Bleu',$3,$4)`,
          [randomUUID(), owner, plate, active],
        );
      for (const [owner, status] of [
        [driverId, 'completed'],
        [driverId, 'ongoing'],
        [otherId, 'completed'],
      ])
        await db.query(`INSERT INTO trips VALUES($1,$2,$3)`, [
          randomUUID(),
          owner,
          status,
        ]);
      for (const rating of [4, 5])
        await db.query('INSERT INTO ratings VALUES($1,$2,$3)', [
          randomUUID(),
          driverId,
          rating,
        ]);
      const response = await get().expect(200);
      expect(response.body.vehicles).toHaveLength(1);
      expect(response.body.vehicles[0].licensePlate).toBe('PUBLIC');
      expect(response.body).toMatchObject({
        completedTrips: 1,
        averageRating: 4.5,
        totalRatings: 2,
      });
    });
    it('reflects a settled credit in the next scan with no amount in browser HTML', async () => {
      await db.query(
        `UPDATE asset_credits SET status='settled' WHERE "driverId"=$1 AND status='active'`,
        [driverId],
      );
      const response = await get().expect(200);
      expect(response.body.credits).toEqual([
        { assetKind: 'phone', status: 'settled' },
      ]);
      const page = await request(app.getHttpServer())
        .get(`/api/v1/public/drivers/${driverId}/card`)
        .expect(200);
      expect(page.text).toContain('Soldé');
      expect(page.text).not.toContain('En cours');
      expect(page.text).not.toMatch(
        /123456789|987654321|principalMinor|dueMinor/,
      );
      expect(page.headers['cache-control']).toBe('no-store');
    });
  },
);
