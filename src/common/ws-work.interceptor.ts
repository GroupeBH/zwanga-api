import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { defer, finalize, mergeMap } from 'rxjs';
import { WsSessionService } from './services/ws-session.service';

@Injectable()
export class WsWorkInterceptor implements NestInterceptor {
  constructor(private readonly sessions: WsSessionService) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    let release: (() => void) | undefined;
    return defer(async () => {
      release = await this.sessions.begin(context.switchToWs().getClient());
      return next.handle();
    }).pipe(mergeMap(result => result), finalize(() => release?.()));
  }
}
