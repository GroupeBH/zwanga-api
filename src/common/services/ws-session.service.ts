import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
import { DataSource, In } from 'typeorm';
import type { Socket } from 'socket.io';
import { User, UserStatus } from '../../users/entities/user.entity';
import { matchesStoredToken } from '../../auth/token-fingerprint';
import { authenticateSocket, socketUserId } from '../websocket-security';
import { RedisService } from './redis.service';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import { pruneTrackingRooms } from './ws-tracking-rooms';

@Injectable()
export class WsSessionService implements OnModuleInit, OnModuleDestroy {
  private readonly sessions = new Map<Socket, { token: string; timer: NodeJS.Timeout }>();
  private readonly inFlight = new Map<string, number>();
  private sweepTimer?: NodeJS.Timeout;
  private sweeping = false;
  constructor(private readonly dataSource: DataSource, private readonly redis: RedisService) {}

  onModuleInit() {
    this.sweepTimer = setInterval(() => void this.validateSessions(), 10_000);
    this.sweepTimer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.sweepTimer);
    for (const socket of this.sessions.keys()) this.close(socket);
  }
  private allowed(user: User | undefined | null, token: string) {
    return !!user && user.isActive && ![UserStatus.INACTIVE, UserStatus.SUSPENDED].includes(user.status)
      && matchesStoredToken(user.accessToken, token);
  }
  private users(ids: string[]) {
    return this.dataSource.getRepository(User).find({ where: { id: In(ids) },
      select: ['id', 'isActive', 'status', 'accessToken'] });
  }
  private close(socket: Socket) {
    const session = this.sessions.get(socket);
    if (session) clearTimeout(session.timer);
    this.sessions.delete(socket);
    socket.emit('session_expired', { message: 'Votre session doit être renouvelée.' });
    socket.disconnect();
  }
  async connect(socket: Socket, jwt: JwtService, config: ConfigService): Promise<boolean> {
    try {
      if (this.sessions.size >= 2000 || !(await authenticateSocket(socket, jwt, config))) {
        socket.disconnect();
        return false;
      }
      const token = socket.handshake.auth?.token ?? /^Bearer\s+(\S+)$/i.exec(String(socket.handshake.headers.authorization ?? ''))?.[1];
      const userId = socketUserId(socket);
      const attempts = await new RedisThrottlerStorage(this.redis).increment(`ws:connect:${userId}`, 60_000);
      if (attempts.totalHits > 30 || !this.allowed((await this.users([userId]))[0], token)) {
        this.close(socket);
        return false;
      }
      if (this.sessions.size >= 2000 || [...this.sessions.keys()].filter(client => client.data.userId === userId).length >= 6) {
        socket.disconnect(); return false;
      }
      // Expiry also disconnects passive subscribers: checking incoming messages is insufficient.
      const timer = setTimeout(() => this.close(socket), Math.min(2_147_483_647,
        Math.max(0, Number(socket.data.authExpiresAt) - Date.now())));
      timer.unref();
      this.sessions.set(socket, { token, timer });
      socket.once('disconnect', () => {
        clearTimeout(timer);
        this.sessions.delete(socket);
      });
      return true;
    } catch {
      this.close(socket);
      return false;
    }
  }
  async validateSessions() {
    if (this.sweeping || !this.sessions.size) return;
    this.sweeping = true;
    try {
      const ids = [...new Set([...this.sessions.keys()].map(socket => socketUserId(socket)))];
      const users = new Map((await this.users(ids)).map(user => [user.id, user]));
      for (const [socket, session] of this.sessions) {
        if (!this.allowed(users.get(socketUserId(socket)), session.token)) this.close(socket);
      }
      await pruneTrackingRooms(this.dataSource, [...this.sessions.keys()]);
    } catch {
      // Fail closed if server-owned account/session state cannot be checked.
      for (const socket of this.sessions.keys()) this.close(socket);
    } finally { this.sweeping = false; }
  }
  async begin(socket: Socket): Promise<() => void> {
    if (!this.sessions.has(socket)) throw new WsException('Authentification requise.');
    const id = socketUserId(socket);
    const count = this.inFlight.get(id) ?? 0;
    const total = [...this.inFlight.values()].reduce((sum, value) => sum + value, 0);
    if (count >= 3 || total >= 64) throw new WsException('Une opération est déjà en cours. Réessayez dans un instant.');
    this.inFlight.set(id, count + 1);
    const release = () => {
      const next = (this.inFlight.get(id) ?? 1) - 1;
      if (next) this.inFlight.set(id, next); else this.inFlight.delete(id);
    };
    try {
      const quota = await new RedisThrottlerStorage(this.redis).increment(`ws:events:${id}`, 60_000);
      if (quota.totalHits > 120) throw new WsException('Trop de demandes. Réessayez dans un instant.');
      return release;
    } catch (error) { release(); throw error; }
  }
}
