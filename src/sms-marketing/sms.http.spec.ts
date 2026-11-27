import 'reflect-metadata';
import { Injectable, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { IpThrottlerGuard } from '../common/guards/throttler.guard';
import {
  SmsMarketingController,
  SmsUnsubscribeController,
} from './sms.controller';
import { SmsCampaignsService } from './sms.campaigns';
import { SmsDeliveryService } from './sms.delivery';
import { SmsOptOutsService } from './sms.opt-outs';
import { SmsAudienceDto } from './sms.dto';

const secret = randomBytes(32).toString('hex');
@Injectable()
class SmsTestStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: secret,
      algorithms: ['HS256'],
      ignoreExpiration: false,
    });
  }
  validate(payload: { sub: string; role: string }) {
    return { userId: payload.sub, role: payload.role };
  }
}
describe('SMS HTTP routes (isolated, signed synthetic JWTs)', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret });
  const actor = randomUUID(),
    id = randomUUID();
  const token = (role = 'admin') =>
    jwt.sign({ sub: actor, role }, { expiresIn: '1m' });
  const campaigns = {
    status: jest.fn(async () => ({ enabled: false })),
    estimate: jest.fn(async () => ({ recipients: 0 })),
    create: jest.fn(async () => ({ id })),
    get: jest.fn(async () => ({ id })),
    list: jest.fn(async () => ({ items: [], total: 0, page: 1, limit: 25 })),
  };
  const delivery = { test: jest.fn(async () => ({ id })) };
  const optOuts = {
    publicPage: jest.fn(
      async (_code: string, confirm: boolean) =>
        `<!doctype html><html lang="fr"><body>${confirm ? 'Confirmation' : 'Confirmer'}</body></html>`,
    ),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        PassportModule,
        ThrottlerModule.forRoot([{ ttl: 60000, limit: 1000 }]),
      ],
      controllers: [SmsMarketingController, SmsUnsubscribeController],
      providers: [
        SmsTestStrategy,
        { provide: SmsCampaignsService, useValue: campaigns },
        { provide: SmsDeliveryService, useValue: delivery },
        { provide: SmsOptOutsService, useValue: optOuts },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: IpThrottlerGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  it('rejects missing, expired and forged JWTs', async () => {
    const url = '/api/v1/admin/sms-marketing/status';
    await request(app.getHttpServer()).get(url).expect(401);
    for (const bad of [
      jwt.sign({ sub: actor }, { expiresIn: -1 }),
      jwt.sign({ sub: actor }, { secret: 'not-the-secret' }),
    ])
      await request(app.getHttpServer())
        .get(url)
        .auth(bad, { type: 'bearer' })
        .expect(401);
    expect(campaigns.status).not.toHaveBeenCalled();
  });
  it.each(['admin', 'super_admin', 'marketer'])(
    'allows authenticated read for %s',
    async (role) => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/sms-marketing/status')
        .auth(token(role), { type: 'bearer' })
        .expect(200);
      expect(campaigns.status).toHaveBeenCalledWith(actor);
    },
  );
  it.each(['passenger', 'driver'])(
    'denies back-office routes to %s',
    async (role) => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/sms-marketing/status')
        .auth(token(role), { type: 'bearer' })
        .expect(403);
    },
  );
  it('validates nested audience and forbids injected recipient phone in a test', async () => {
    const url = '/api/v1/admin/sms-marketing';
    const invalid = await request(app.getHttpServer())
      .post(url + '/audience/estimate')
      .auth(token(), { type: 'bearer' })
      .send({ message: 'Salut' })
      .expect(400);
    expect(invalid.body).toMatchObject({
      code: 'SMS_INVALID_INPUT',
      message: 'Vérifiez les champs, dates et numéros saisis.',
    });
    await request(app.getHttpServer())
      .post(url + '/audience/estimate')
      .auth(token(), { type: 'bearer' })
      .send({
        message: 'Salut',
        audience: { ...new SmsAudienceDto(), roles: ['admin'] },
      })
      .expect(400);
    await request(app.getHttpServer())
      .post(url + `/campaigns/${id}/test`)
      .auth(token(), { type: 'bearer' })
      .send({ revision: 1, requestId: randomUUID(), phone: '+243900000099' })
      .expect(400);
    expect(delivery.test).not.toHaveBeenCalled();
  });
  it('renders public no-store HTML without external resources and GET does not confirm', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/sms/s/Ab3dE9xK')
      .expect(200);
    expect(optOuts.publicPage).toHaveBeenCalledWith('Ab3dE9xK', false);
    expect(res.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    await request(app.getHttpServer())
      .post('/api/v1/sms/s/Ab3dE9xK')
      .expect(200);
    expect(optOuts.publicPage).toHaveBeenCalledWith('Ab3dE9xK', true);
  });
  it('shares the public 20/minute IP budget across codes, GET and POST', async () => {
    // Two calls above already consumed this IP budget.
    for (let i = 0; i < 18; i++)
      await request(app.getHttpServer())
        [i % 2 ? 'get' : 'post'](`/api/v1/sms/s/${String(i).padStart(8, '0')}`)
        .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/sms/s/Unknown1')
      .expect(429);
  });
});
