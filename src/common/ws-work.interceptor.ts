import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { defer, EMPTY, finalize, mergeMap } from 'rxjs';
import { WsSessionService } from './services/ws-session.service';

@Injectable()
export class WsWorkInterceptor implements NestInterceptor {
  constructor(private readonly sessions: WsSessionService) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    return defer(() => {
      // Per subscription: cancellation can happen while Redis admission is
      // still pending. Its eventual slot must not leak or start cancelled work.
      let release: (() => void) | undefined;
      let finished = false;
      return defer(async () => {
        release = await this.sessions.begin(context.switchToWs().getClient());
        if (finished) { release(); return EMPTY; }
        return next.handle();
      }).pipe(mergeMap(result => result), finalize(() => {
        finished = true;
        release?.();
      }));
    });
  }
}
