import { Injectable, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { firstValueFrom, isObservable } from 'rxjs';
const VERIFIED_REQUEST = Symbol('verified-jwt-request');

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') return true;
    // Vérifier si la route est marquée comme publique
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Si la route est publique, autoriser l'accès sans authentification
    if (isPublic) {
      return true;
    }

    // Sinon, appliquer l'authentification JWT normale
    const request = context.switchToHttp().getRequest();
    // Only this guard can set the symbol; req.user alone is never authentication proof.
    if (request[VERIFIED_REQUEST]) return true;
    const result = await super.canActivate(context);
    const allowed = isObservable(result) ? await firstValueFrom(result) : result;
    if (allowed) request[VERIFIED_REQUEST] = true;
    return allowed;
  }
}

