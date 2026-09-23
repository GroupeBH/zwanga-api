import { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server, ServerOptions } from 'socket.io';
import { createSocketOriginOptions } from './cors-policy';

export class ConfiguredIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly configService: ConfigService,
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    // Apply one policy to the shared Engine.IO server, regardless of namespace order.
    return super.createIOServer(port, {
      ...options,
      ...createSocketOriginOptions(this.configService),
    }) as Server;
  }
}
