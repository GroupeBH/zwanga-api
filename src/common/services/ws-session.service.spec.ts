import { EventEmitter } from 'events';
import { JwtService } from '@nestjs/jwt';
import { WsSessionService } from './ws-session.service';
import { tokenFingerprint } from '../../auth/token-fingerprint';

describe('Server-owned WebSocket sessions', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const jwt = new JwtService({ secret: 'test-secret' });
  const config = { get: () => 'test-secret' } as any;
  const create = () => {
    const token = jwt.sign({ sub: id }, { expiresIn: '1h' });
    const user = { id, accessToken: tokenFingerprint(token), isActive: true, status: 'active' };
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
});
