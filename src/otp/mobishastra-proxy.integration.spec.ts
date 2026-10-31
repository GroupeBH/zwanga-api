import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import axios from 'axios';
import { createServer as createHttpServer } from 'node:http';
import { Agent, createServer as createHttpsServer } from 'node:https';
import { connect, type Socket, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import {
  certificate,
  privateKey,
} from '../../test/fixtures/mobishastra-test-tls';
import { MobishastraSmsService } from './mobishastra-sms.service';

describe('Mobishastra CONNECT integration (loopback only, no real SMS)', () => {
  const phone = '243900000000';
  let mode: 'allow' | 'deny' | 'hang';
  let redirect: boolean;
  let bodies: unknown[];
  let tunnels: string[];
  let proxyHeaders: string[];
  let wire: Buffer[];
  let nonConnectRequests: number;
  let provider: ReturnType<typeof createHttpsServer>;
  let proxy: ReturnType<typeof createHttpServer>;
  let sockets: Set<Duplex>;
  let proxyConnections: Set<Socket>;
  let services: MobishastraSmsService[];

  const fixture = (trustTestCertificate = true) => {
    const client = axios.create();
    client.interceptors.request.use((config) => {
      // Trust this synthetic CA only for this test client. TLS verification stays on.
      const agent = config.httpsAgent as Agent;
      if (trustTestCertificate) agent.options.ca = certificate;
      if (mode === 'hang') {
        // Accelerate BOTH production deadlines (overall request + pending socket).
        expect(config.timeout).toBe(10000);
        expect(agent.options.timeout).toBe(10000);
        config.timeout = 100;
        agent.options.timeout = 100;
      }
      return config;
    });
    const service = new MobishastraSmsService(
      new ConfigService({
        NODE_ENV: 'test',
        MOBISHASTRA_PROFILE_ID: 'test-profile',
        MOBISHASTRA_PASSWORD: 'private-password',
        MOBISHASTRA_SENDER_ID: 'ZWANGA',
        MOBISHASTRA_SMS_URL: 'https://valuesms.ae/sendsms_api_json.aspx',
        MOBISHASTRA_PROXY_REQUIRED: 'true',
        MOBISHASTRA_PROXY_URL: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      }),
      new HttpService(client),
    );
    services.push(service);
    return service;
  };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    mode = 'allow';
    redirect = false;
    bodies = [];
    tunnels = [];
    proxyHeaders = [];
    wire = [];
    nonConnectRequests = 0;
    sockets = new Set();
    proxyConnections = new Set();
    services = [];
    provider = createHttpsServer(
      { key: privateKey, cert: certificate },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
          if (redirect) {
            res.writeHead(302, { Location: 'https://not-allowed.invalid/' });
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify([
              { number: phone, msg_id: 'test', response: 'send success' },
            ]),
          );
        });
      },
    );
    provider.on('connection', (socket: Socket) => sockets.add(socket));
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    proxy = createHttpServer((_req, res) => {
      nonConnectRequests++;
      res.writeHead(403);
      res.end();
    });
    proxy.on('connection', (socket: Socket) => {
      sockets.add(socket);
      proxyConnections.add(socket);
      socket.on('close', () => proxyConnections.delete(socket));
    });
    proxy.on('connect', (req, downstream, head) => {
      tunnels.push(req.url ?? '');
      proxyHeaders.push(req.rawHeaders.join('\n'));
      if (mode === 'deny' || req.url !== 'valuesms.ae:443') {
        downstream.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      if (mode === 'hang') {
        // Upgraded HTTP sockets are paused/half-open by default. Read FIN so
        // the test can observe the client's cancellation and close its half.
        downstream.on('end', () => downstream.end());
        downstream.resume();
        return;
      }
      // Destination is ALWAYS the owned loopback TLS server; never resolve req.url.
      const upstream = connect(
        (provider.address() as AddressInfo).port,
        '127.0.0.1',
      );
      sockets.add(upstream);
      upstream.on('error', () => downstream.destroy());
      downstream.on('error', () => upstream.destroy());
      downstream.on('close', () => upstream.destroy());
      upstream.on('connect', () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        downstream.on('data', (chunk: Buffer) => wire.push(chunk));
        downstream.pipe(upstream);
        upstream.pipe(downstream);
      });
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
  });

  afterEach(async () => {
    for (const service of services) service.onModuleDestroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [provider, proxy].map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    jest.restoreAllMocks();
  });

  it('sends a real HTTPS POST through CONNECT without exposing the SMS to the proxy', async () => {
    await expect(fixture().sendCode(phone, '12345')).resolves.toBeUndefined();
    expect(tunnels).toEqual(['valuesms.ae:443']);
    expect(nonConnectRequests).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject([
      { pwd: 'private-password', number: phone },
    ]);
    expect(bodies[0]).toHaveProperty(
      '0.msg',
      'Zwanga : votre code de verification est 12345. Valable 15 minutes. Ne le partagez avec personne.',
    );
    expect(proxyHeaders.join('')).not.toMatch(
      /private-password|12345|243900000000/,
    );
    expect(Buffer.concat(wire).includes(Buffer.from('private-password'))).toBe(
      false,
    );
  });

  it('keeps origin certificate verification enabled through the tunnel', async () => {
    await expect(fixture(false).sendCode(phone, '12345')).rejects.toMatchObject(
      { status: 503 },
    );
    expect(tunnels).toHaveLength(1);
    expect(bodies).toHaveLength(0);
  });

  it('does not retry or connect directly after proxy refusal', async () => {
    mode = 'deny';
    await expect(fixture().sendCode(phone, '12345')).rejects.toMatchObject({
      response: { code: 'OTP_SMS_UNAVAILABLE' },
    });
    expect(tunnels).toHaveLength(1);
    expect(bodies).toHaveLength(0);
  });

  it('bounds an unresponsive CONNECT handshake with the whole-request deadline', async () => {
    mode = 'hang';
    const realTimeout = AbortSignal.timeout.bind(AbortSignal) as (
      ms: number,
    ) => AbortSignal;
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => realTimeout(100));
    await expect(fixture().sendCode(phone, '12345')).rejects.toMatchObject({
      status: 503,
    });
    expect(timeout).toHaveBeenCalledWith(10000);
    expect(tunnels).toHaveLength(1);
    expect(bodies).toHaveLength(0);
    // An HTTP timeout must also close the pending tunnel, not leak TCP sockets.
    for (let i = 0; i < 20 && proxyConnections.size; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(proxyConnections.size).toBe(0);
  });

  it('does not follow a provider redirect through or outside the proxy', async () => {
    redirect = true;
    await expect(fixture().sendCode(phone, '12345')).rejects.toMatchObject({
      status: 503,
    });
    expect(tunnels).toHaveLength(1);
    expect(bodies).toHaveLength(1);
  });

  it('ignores global proxy bypass settings when the dedicated proxy is selected', async () => {
    const previous = process.env.NO_PROXY;
    try {
      process.env.NO_PROXY = '*';
      await fixture().sendCode(phone, '12345');
      expect(tunnels).toEqual(['valuesms.ae:443']);
    } finally {
      if (previous === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = previous;
    }
  });
});
