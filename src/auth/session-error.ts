import { HttpException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

/** Infrastructure failures must deny access without revoking valid mobile sessions. */
export function rethrowSessionError(error: unknown): never {
  if (error instanceof HttpException && error.getStatus() < 500) throw error;
  if (error instanceof Error && ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) {
    throw new UnauthorizedException('Votre session est invalide ou a expiré.');
  }
  throw new ServiceUnavailableException('Vérification de session temporairement indisponible. Réessayez.');
}
