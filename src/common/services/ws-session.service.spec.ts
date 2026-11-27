import { EventEmitter } from 'events';
import { JwtService } from '@nestjs/jwt';
import { WsSessionService } from './ws-session.service';
import { tokenFingerprint } from '../../auth/token-fingerprint';

describe('Server-owned WebSocket sessions', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const jwt = new JwtService({ secret: 'test-secret' });
  const config = { get: () => 'test-secret' } as any;
  const create = (userId = id) => {
    const token = jwt.sign({ sub: userId }, { expiresIn: '1h' });
    const user = { id: userId, accessToken: tokenFingerprint(token), isActive: true, status: 'active' };
    const find = jest.fn().mockImplementation(async () => [user]);
    const evalMock = jest.fn().mockResolvedValue([1, 60000]);
    const service = new WsSessionService({ getRepository: () => ({ find }) } as any,
      { getClient: () => ({ eval: evalMock }) } as any);
    const events = new EventEmitter();
    const socket = { handshake: { auth: { token }, headers: {} }, data: {},
      emit: jest.fn(), once: events.once.bind(events), disconnect: jest.fn(() => events.emit('disconnect')) } as any;
    return { service, socket, user, find, evalMock };
  };
  it('rejects suspended/deactivated accounts at connection time', async () => {
    const { service, socket, user } = create();
    user.status = 'suspended';
    expect(await service.connect(socket, jwt, config)).toBe(false);
    expect(socket.disconnect).toHaveBeenCalled();
    service.onModuleDestroy();
  });
  it('cleans timers without revoking sessions before the deployment drain', async () => {
    const { service, socket } = create();
    expect(await service.connect(socket, jwt, config)).toBe(true);
    service.onModuleDestroy();
    await service.validateSessions();
    expect(socket.emit).not.toHaveBeenCalledWith('session_expired', expect.anything());
    expect(socket.disconnect).not.toHaveBeenCalled();
    await expect(service.begin(socket)).rejects.toThrow('Authentification');
  });
  it('disconnects passive subscribers when their JWT expires', async () => {
    jest.useFakeTimers();
    const { service, socket } = create();
    try {
      expect(await service.connect(socket, jwt, config)).toBe(true);
      jest.advanceTimersByTime(3600001);
      expect(socket.disconnect).toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith('session_expired', expect.any(Object));
    } finally { service.onModuleDestroy(); jest.useRealTimers(); }
  });
  it('rechecks server revocation and releases pending operation slots', async () => {
    const { service, socket, user } = create();
    try {
      await service.connect(socket, jwt, config);
      const releases = await Promise.all([service.begin(socket), service.begin(socket), service.begin(socket)]);
      await expect(service.begin(socket)).rejects.toThrow('opération');
      releases.forEach(release => release());
      (await service.begin(socket))();
      user.accessToken = '';
      await service.validateSessions();
      expect(socket.disconnect).toHaveBeenCalled();
      await expect(service.begin(socket)).rejects.toThrow('Authentification');
    } finally { service.onModuleDestroy(); }
  });
  it('disconnects on a database outage without falsely expiring the token', async () => {
    const { service, socket, find } = create();
    try {
      await service.connect(socket, jwt, config);
      find.mockRejectedValue(new Error('database unavailable'));
      await service.validateSessions();
      expect(socket.disconnect).toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalledWith('session_expired', expect.anything());
      expect(socket.emit).toHaveBeenCalledWith('server_restart', {
        reason: 'dependency_unavailable', reconnect: true, retryAfterSeconds: 5,
      });
      await expect(service.begin(socket)).rejects.toThrow('Authentification');
    } finally { service.onModuleDestroy(); }
  });
  it('fails closed on Redis connection failure without revoking valid credentials', async () => {
    const { service, socket, evalMock } = create();
    evalMock.mockRejectedValue(new Error('offline'));
    expect(await service.connect(socket, jwt, config)).toBe(false);
    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalledWith('session_expired', expect.anything());
    service.onModuleDestroy();
  });

  it('preserves a session registered during the user query and validates it on the next sweep', async () => {
    const { service, socket, user, find } = create();
    const newcomer = create('00000000-0000-4000-8000-000000000002');
    try {
      await service.connect(socket, jwt, config);
      let finish!: (rows: unknown[]) => void;
      find.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const sweep = service.validateSessions();
      find.mockResolvedValue([newcomer.user]);
      expect(await service.connect(newcomer.socket, jwt, config)).toBe(true);
      finish([user]);
      await sweep;
      expect(newcomer.socket.disconnect).not.toHaveBeenCalled();
      expect(newcomer.socket.emit).not.toHaveBeenCalledWith('session_expired', expect.anything());
      expect(socket.disconnect).not.toHaveBeenCalled();

      find.mockResolvedValue([user, { ...newcomer.user, isActive: false }]);
      await service.validateSessions();
      expect(newcomer.socket.disconnect).toHaveBeenCalledTimes(1);
      expect(newcomer.socket.emit).toHaveBeenCalledWith('session_expired', expect.anything());
      expect(socket.disconnect).not.toHaveBeenCalled();
    } finally { service.onModuleDestroy(); newcomer.service.onModuleDestroy(); }
  });

  it('fails closed only for the checked sessions if their query fails during a new successful connection', async () => {
    const { service, socket, find } = create();
    const newcomer = create('00000000-0000-4000-8000-000000000002');
    try {
      await service.connect(socket, jwt, config);
      let rejectRead!: (error: Error) => void;
      find.mockImplementationOnce(() => new Promise((_, reject) => { rejectRead = reject; }));
      const sweep = service.validateSessions();
      find.mockResolvedValue([newcomer.user]);
      expect(await service.connect(newcomer.socket, jwt, config)).toBe(true);
      rejectRead(new Error('one query failed'));
      await sweep;
      expect(socket.disconnect).toHaveBeenCalledTimes(1);
      expect(socket.emit).toHaveBeenCalledWith('server_restart', expect.anything());
      expect(newcomer.socket.disconnect).not.toHaveBeenCalled();
      (await service.begin(newcomer.socket))();
    } finally { service.onModuleDestroy(); newcomer.service.onModuleDestroy(); }
  });

  it('does not revoke a reconnected socket from the stale result of an earlier sweep', async () => {
    const { service, socket, user, find } = create();
    try {
      await service.connect(socket, jwt, config);
      let finish!: (rows: unknown[]) => void;
      find.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const sweep = service.validateSessions();
      socket.disconnect();
      expect(await service.connect(socket, jwt, config)).toBe(true);
      socket.disconnect.mockClear();
      finish([{ ...user, accessToken: '' }]);
      await sweep;
      expect(socket.disconnect).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalledWith('session_expired', expect.anything());
    } finally { service.onModuleDestroy(); }
  });

  it('still fails closed when trip membership cannot be revalidated', async () => {
    const { service, socket, user, find } = create();
    try {
      await service.connect(socket, jwt, config);
      socket.rooms = new Set(['trip:synthetic']);
      find.mockResolvedValueOnce([user]).mockRejectedValueOnce(new Error('trip query failed'));
      await service.validateSessions();
      expect(socket.disconnect).toHaveBeenCalledTimes(1);
      expect(socket.emit).toHaveBeenCalledWith('server_restart', expect.anything());
    } finally { service.onModuleDestroy(); }
  });

  it('counts global admissions synchronously and releases a slot only once', async () => {
    const { service, socket } = create();
    const releases: Array<() => void> = [];
    try {
      await service.connect(socket, jwt, config);
      // Authorization itself is covered above; distinct registered sockets
      // isolate global admission from the per-user three-operation ceiling.
      const sockets = Array.from({ length: 64 }, (_, i) => ({ data: { userId: `test-${i}` } } as any));
      for (const s of sockets) (service as any).sessions.set(s, { token: '', timer: undefined });
      releases.push(...await Promise.all(sockets.map(s => service.begin(s))));
      await expect(service.begin(socket)).rejects.toThrow('opération');
      expect(service.workloadSnapshot()).toEqual({ active: 64, peak: 64,
        rejected: { global: 1, user: 0 }, limits: { global: 64, perUser: 3 } });
      releases[0](); releases[0]();
      expect(service.workloadSnapshot().active).toBe(63);
      releases.push(await service.begin(socket));
      expect(service.workloadSnapshot().active).toBe(64);
      releases.forEach(release => release());
      expect(service.workloadSnapshot().active).toBe(0);
    } finally { releases.forEach(release => release()); service.onModuleDestroy(); }
  });

  it('distinguishes per-user pressure and releases failed Redis admissions', async () => {
    const { service, socket, evalMock } = create();
    const releases: Array<() => void> = [];
    try {
      await service.connect(socket, jwt, config);
      releases.push(...await Promise.all([service.begin(socket), service.begin(socket), service.begin(socket)]));
      await expect(service.begin(socket)).rejects.toThrow('opération');
      releases.forEach(release => release());
      evalMock.mockRejectedValueOnce(new Error('redis unavailable'));
      await expect(service.begin(socket)).rejects.toThrow('Service temporairement indisponible');
      expect(service.workloadSnapshot()).toMatchObject({ active: 0, peak: 3, rejected: { user: 1, global: 0 } });
      const snapshot = service.workloadSnapshot(); snapshot.rejected.user = 999;
      expect(service.workloadSnapshot().rejected.user).toBe(1);
    } finally { releases.forEach(release => release()); service.onModuleDestroy(); }
  });
});
