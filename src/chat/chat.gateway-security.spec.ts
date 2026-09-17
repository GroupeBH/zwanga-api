import { ForbiddenException, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { Namespace } from 'socket.io';
import request from 'supertest';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { ConfiguredIoAdapter } from '../common/configured-io.adapter';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { TripsService } from '../trips/trips.service';
import { BookingsService } from '../bookings/bookings.service';

const passenger = '00000000-0000-4000-8000-000000000001';
const driver = '00000000-0000-4000-8000-000000000002';
const outsider = '00000000-0000-4000-8000-000000000003';
const bookingId = '00000000-0000-4000-8000-000000000004';

// Exercise Nest guards, pipes and exception filters over real Socket.IO frames,
// without adding a client dependency or using a database/Redis instance.
class SocketTestClient {
  readonly socket: WebSocket;
  readonly history: string[] = [];
  private readonly pending: string[] = [];
  private wake?: () => void;
  id = '';

  constructor(
    url: string,
    readonly namespace: string,
  ) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', (event: MessageEvent<string>) => {
      if (event.data === '2') {
        this.socket.send('3');
        return;
      }
      this.history.push(event.data);
      this.pending.push(event.data);
      this.wake?.();
    });
  }

  take(prefix: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        reject(new Error(`No Socket.IO packet matching ${prefix}`));
      }, 3000);
      this.wake = () => {
        const index = this.pending.findIndex((frame) =>
          frame.startsWith(prefix),
        );
        if (index < 0) return;
        clearTimeout(timer);
        this.wake = undefined;
        resolve(this.pending.splice(index, 1)[0]);
      };
      this.wake();
    });
  }

  emit(event: string, payload: unknown, ack = '') {
    this.socket.send(
      `42${this.namespace},${ack}${JSON.stringify([event, payload])}`,
    );
  }

  event(name: string) {
    return this.take(`42${this.namespace},["${name}",`);
  }
}

describe('Chat and tracking Socket.IO security integration', () => {
  let app: INestApplication;
  let server: Server;
  let namespace: Namespace;
  let url: string;
  const clients: SocketTestClient[] = [];
  const jwt = new JwtService({ secret: 'socket-integration-test-only' });
  const config = new ConfigService({
    JWT_SECRET: 'socket-integration-test-only',
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://app.example.test',
    GPS_LOG_SAMPLE_RATE: '0',
  });
  const chat = {
    ensureUserCanAccessBookingChat: jest.fn((id: string, userId: string) => {
      if (id !== bookingId || ![passenger, driver].includes(userId)) {
        return Promise.reject(new ForbiddenException('Accès refusé.'));
      }
      return Promise.resolve();
    }),
    createMessage: jest
      .fn()
      .mockResolvedValue({ id: 'message', content: 'Bonjour' }),
    getMessages: jest.fn().mockResolvedValue([]),
  };
  const trips = { updateDriverLocation: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ChatGateway,
        TrackingGateway,
        { provide: ChatService, useValue: chat },
        { provide: TripsService, useValue: trips },
        { provide: BookingsService, useValue: {} },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useWebSocketAdapter(new ConfiguredIoAdapter(app, config));
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer() as Server;
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket.io/?EIO=4&transport=websocket`;
    namespace = module.get(ChatGateway).server as unknown as Namespace;
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.socket.close();
    jest.clearAllMocks();
  });
  afterAll(async () => {
    await app?.close();
  });

  async function connect(userId: string, path = '/chat') {
    const client = new SocketTestClient(url, path);
    clients.push(client);
    await client.take('0');
    client.socket.send(
      `40${path},${JSON.stringify({ token: jwt.sign({ sub: userId }, { expiresIn: '1h' }) })}`,
    );
    const connected = await client.take(`40${path},`);
    client.id = (
      JSON.parse(connected.slice(`40${path},`.length)) as { sid: string }
    ).sid;
    return client;
  }

  it('only joins the passenger and driver, and never broadcasts to an outsider', async () => {
    const [passengerClient, driverClient, attacker] = await Promise.all([
      connect(passenger),
      connect(driver),
      connect(outsider),
    ]);
    for (const client of [passengerClient, driverClient]) {
      client.emit('join_booking', { bookingId }, '1');
      expect(await client.take('43/chat,1')).toContain('"success":true');
    }
    attacker.emit('join_booking', { bookingId });
    expect(await attacker.event('error')).toContain('Accès refusé.');
    expect(namespace.adapter.rooms.get(`booking:${bookingId}`)).toEqual(
      new Set([passengerClient.id, driverClient.id]),
    );
    passengerClient.emit('send_message', { bookingId, content: 'Bonjour' });
    expect(await passengerClient.event('new_message')).toContain('Bonjour');
    expect(await driverClient.event('new_message')).toContain('Bonjour');
    // This next event is a delivery barrier on the attacker's connection.
    namespace.to(attacker.id).emit('barrier', {});
    await attacker.event('barrier');
    expect(
      attacker.history.some((frame) => frame.includes('new_message')),
    ).toBe(false);
  });

  it.each([{}, { bookingId: 'not-a-uuid' }, { bookingId, userId: passenger }])(
    'validates join payloads before calling the service: %j',
    async (payload) => {
      const client = await connect(passenger);
      client.emit('join_booking', payload);
      expect(await client.event('error')).toContain(
        'Données WebSocket invalides.',
      );
      expect(chat.ensureUserCanAccessBookingChat).not.toHaveBeenCalled();
    },
  );

  it('rejects messages without content before calling the service', async () => {
    const client = await connect(passenger);
    client.emit('send_message', { bookingId });
    expect(await client.event('error')).toContain(
      'Données WebSocket invalides.',
    );
    expect(chat.createMessage).not.toHaveBeenCalled();
  });

  it('rejects an event while authentication has not established a user identity', async () => {
    const client = await connect(passenger);
    const session = namespace.sockets.get(client.id)!.data as Record<
      string,
      unknown
    >;
    delete session.userId;
    client.emit('join_booking', { bookingId });
    expect(await client.event('error')).toContain('Authentification requise.');
    expect(chat.ensureUserCanAccessBookingChat).not.toHaveBeenCalled();
  });

  it('validates tracking payloads through its own gateway pipeline', async () => {
    const client = await connect(driver, '/tracking');
    client.emit('driver_location_update', {
      tripId: bookingId,
      coordinates: ['15.3', '-4.3'],
    });
    expect(await client.event('error')).toContain(
      'Données WebSocket invalides.',
    );
    expect(trips.updateDriverLocation).not.toHaveBeenCalled();
  });

  it('accepts native polling and allowlisted web origins, but rejects other origins', async () => {
    const path = '/socket.io/?EIO=4&transport=polling';
    await request(server).get(path).expect(200);
    await request(server)
      .get(path)
      .set('Origin', 'https://app.example.test')
      .expect('Access-Control-Allow-Origin', 'https://app.example.test')
      .expect(200);
    await request(server)
      .get(path)
      .set('Origin', 'https://attacker.example.test')
      .expect(400);
  });
});
