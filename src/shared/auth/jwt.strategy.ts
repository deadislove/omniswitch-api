import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '../decorators/roles.decorator';
import { TokenRevocationService } from './token-revocation.service';

export interface JwtPayload {
  sub: string;          // Subject (user/merchant ID)
  merchantId: string;
  email?: string;
  roles: UserRole[];
  jti?: string;          // Unique token id, used for single-token revocation
  iat?: number;
  exp?: number;
  /**
   * Set only on the short-lived token POST /auth/token issues when the
   * merchant has MFA enabled — this token is deliberately not a fully
   * authenticated session. JwtAuthGuard rejects it on every route except
   * POST /auth/mfa/verify (see @AllowMfaPending()), which trades it for a
   * normal, full JWT once the TOTP/backup code checks out.
   */
  mfaPending?: boolean;
  /** Set only on an agent token (roles: [UserRole.AGENT]) — the Delegation this token was issued for. See delegation.aggregate.ts. */
  delegationId?: string;
}

export interface AuthenticatedUser {
  userId: string;
  merchantId: string;
  email?: string;
  roles: UserRole[];
  jti?: string;
  tokenExp?: number;
  mfaPending?: boolean;
  delegationId?: string;
}

/**
 * JWT Strategy for Passport
 * Validates JWT tokens and extracts user information.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly tokenRevocation: TokenRevocationService,
  ) {
    // No hardcoded fallback: a well-known default secret would let anyone
    // forge a valid JWT (any role, any merchant) for every deployment that
    // forgot to set JWT_SECRET. Fail fast at boot instead.
    const jwtSecret = configService.get<string>('JWT_SECRET');
    if (!jwtSecret || jwtSecret.length < 32) {
      throw new Error(
        'JWT_SECRET must be set to a random value of at least 32 characters. Refusing to start with a missing/weak secret.',
      );
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret,
      algorithms: ['HS256'],
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!payload.sub || !payload.merchantId) {
      throw new UnauthorizedException('Invalid JWT payload structure');
    }

    // Stateless JWTs are normally valid until they naturally expire — these
    // two checks are what let us actually revoke one early (logout, merchant
    // deactivation, "log out everywhere"). Runs on every authenticated
    // request, same as any other auth check. Independent checks, so run them
    // concurrently rather than paying two sequential Redis round-trips.
    const [tokenRevoked, merchantRevoked] = await Promise.all([
      payload.jti ? this.tokenRevocation.isTokenRevoked(payload.jti) : false,
      payload.iat ? this.tokenRevocation.isMerchantTokenRevoked(payload.merchantId, payload.iat) : false,
    ]);
    if (tokenRevoked || merchantRevoked) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Token has been revoked',
        code: 'TOKEN_REVOKED',
      });
    }

    return {
      userId: payload.sub,
      merchantId: payload.merchantId,
      email: payload.email,
      roles: payload.roles || [UserRole.MERCHANT],
      jti: payload.jti,
      tokenExp: payload.exp,
      mfaPending: payload.mfaPending,
      delegationId: payload.delegationId,
    };
  }
}
