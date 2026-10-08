import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';
import { UserStatus } from '../../users/entities/user.entity';
import { rethrowSessionError } from '../session-error';

interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
  ) {
    super({
      secretOrKey: configService.get<string>('JWT_SECRET'),
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
    });
  }

  async validate(payload: JwtPayload) {
    try {
      // Vérifier que l'utilisateur existe toujours et est actif
      const user = await this.usersService.findAuthIdentity(payload.sub);

      if (!user) {
        throw new UnauthorizedException("Utilisateur introuvable.");
      }

      if (user.status === UserStatus.SUSPENDED) {
        throw new UnauthorizedException("Votre compte est suspendu. Contactez l’assistance.");
      }

      if (user.status === UserStatus.INACTIVE || !user.isActive) {
        throw new UnauthorizedException("Votre compte est désactivé. Contactez l’assistance.");
      }

      // Retourner les informations qui seront attachées à req.user
      return {
        userId: user.id,
        email: user.email || user.phone,
        phone: user.phone,
        role: user.role,
        passwordChangeRequired: user.passwordChangeRequired,
      };
    } catch (error) {
      rethrowSessionError(error);
    }
  }
}
