import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_MFA_PENDING_KEY } from '../decorators/allow-mfa-pending.decorator';

/**
 * JWT Authentication Guard
 * Validates JWT Bearer tokens on all protected routes.
 * Routes decorated with @Public() bypass this guard. A token with
 * mfaPending=true (see JwtPayload) is rejected on every route except one
 * decorated with @AllowMfaPending() — MFA verification is not optional
 * once a merchant has enabled it, so a half-finished login can't be used
 * as a normal session just because it's a technically-valid JWT.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(private readonly reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const activated = (await super.canActivate(context)) as boolean;
    if (!activated) {
      return false;
    }

    const req = context.switchToHttp().getRequest();
    if (req.user?.mfaPending) {
      const allowMfaPending = this.reflector.getAllAndOverride<boolean>(ALLOW_MFA_PENDING_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allowMfaPending) {
        this.logger.warn(`Rejected mfaPending token against a non-MFA route (merchant=${req.user?.merchantId})`);
        throw new UnauthorizedException({
          statusCode: 401,
          error: 'MFA verification required',
          code: 'MFA_VERIFICATION_REQUIRED',
        });
      }
    }

    return true;
  }

  handleRequest(err: any, user: any, info: any) {
    if (err || !user) {
      this.logger.warn(`JWT auth failed: ${info?.message || err?.message || 'No token'}`);
      throw err || new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        message: info?.message || 'Invalid or missing JWT token',
        code: 'JWT_AUTH_FAILED',
      });
    }
    return user;
  }
}
