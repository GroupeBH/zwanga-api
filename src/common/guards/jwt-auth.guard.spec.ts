import { AuthGuard } from '@nestjs/passport';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('Request-scoped JWT verification', () => {
  it('verifies once per request even when both global and route guards run', async () => {
    const verify = jest.spyOn(AuthGuard('jwt').prototype, 'canActivate').mockResolvedValue(true);
    try {
      const request = { user: { userId: 'not-proof-of-authentication' } };
      const context = { getType: () => 'http', getHandler: () => 'handler', getClass: () => 'controller',
        switchToHttp: () => ({ getRequest: () => request }) } as any;
      const reflector = { getAllAndOverride: () => false } as any;
      await expect(new JwtAuthGuard(reflector).canActivate(context)).resolves.toBe(true);
      await expect(new JwtAuthGuard(reflector).canActivate(context)).resolves.toBe(true);
      expect(verify).toHaveBeenCalledTimes(1);
    } finally { verify.mockRestore(); }
  });
  it('never records failed validation as authentication', async () => {
    const verify = jest.spyOn(AuthGuard('jwt').prototype, 'canActivate').mockRejectedValue(new Error('invalid'));
    const request = {};
    const context = { getType: () => 'http', getHandler: () => '', getClass: () => '',
      switchToHttp: () => ({ getRequest: () => request }) } as any;
    try {
      const guard = new JwtAuthGuard({ getAllAndOverride: () => false } as any);
      await expect(guard.canActivate(context)).rejects.toThrow();
      await expect(guard.canActivate(context)).rejects.toThrow();
      expect(verify).toHaveBeenCalledTimes(2);
    } finally { verify.mockRestore(); }
  });
});
