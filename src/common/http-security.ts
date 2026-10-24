import type { Express, NextFunction, Request, Response } from 'express';

/** Minimal origin hardening without changing CORS, Swagger scripts or local HTTP. */
export function configureHttpSecurity(
  server: Express,
  apiPrefix: string,
): void {
  server.disable('x-powered-by');
  const prefix = `/${apiPrefix.replace(/^\/+|\/+$/g, '')}`.toLowerCase();
  const sensitivePaths = [`${prefix}/auth`, `${prefix}/users/kyc`];

  server.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const path = req.path.toLowerCase();
    // Includes anonymous login/refresh responses and error responses. Other
    // private API responses also remain outside shared/browser HTTP caches.
    if (
      req.headers.authorization ||
      sensitivePaths.some(
        (base) => path === base || path.startsWith(`${base}/`),
      )
    ) {
      res.setHeader('Cache-Control', 'private, no-store');
    }
    next();
  });
}
