import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, UserRole } from '../decorators/roles.decorator';
import { MerchantService } from '../../modules/merchant/merchant.service';

/**
 * RBAC Roles Guard
 * Enforces role-based access control on routes decorated with @Roles().
 * Must be used after JwtAuthGuard (requires authenticated user in request).
 *
 * Also enforces PCI DSS Req 8.4.2 for ADMIN specifically: an ADMIN-role
 * caller must have MFA enabled, regardless of which of the route's allowed
 * roles they matched on (a route open to `@Roles(ADMIN, OPERATOR)` still
 * requires MFA for a caller whose own token carries ADMIN — OPERATOR
 * callers of the same route are unaffected). This only fires on routes
 * that actually declare `@Roles(...)` — the MFA self-service endpoints
 * (`/auth/mfa/enroll`/`confirm`) have no `@Roles()` at all, so an ADMIN
 * merchant that hasn't enrolled yet can still reach them to do so; there's
 * no separate escape-hatch decorator needed for that reason.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly merchantService: MerchantService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No roles required - allow access
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();

    if (!user) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'No authenticated user found',
        code: 'NO_USER',
      });
    }

    const userRoles: UserRole[] = user.roles || [];
    const hasRole = requiredRoles.some((role) => userRoles.includes(role));

    if (!hasRole) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: `Insufficient permissions. Required roles: [${requiredRoles.join(', ')}]`,
        code: 'INSUFFICIENT_PERMISSIONS',
        requiredRoles,
        userRoles,
      });
    }

    if (userRoles.includes(UserRole.ADMIN)) {
      await this.assertAdminHasMfaEnabled(user.merchantId);
    }

    return true;
  }

  // Only reached for a caller whose own token carries ADMIN, so this DB
  // round-trip doesn't add cost to the far more common
  // MERCHANT/OPERATOR/READONLY/AGENT request path.
  private async assertAdminHasMfaEnabled(merchantId: string): Promise<void> {
    const merchant = await this.merchantService.findByMerchantId(merchantId);
    if (!merchant?.mfaEnabled) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'MFA must be enabled for ADMIN access',
        code: 'MFA_REQUIRED_FOR_ADMIN',
        message: 'Enroll MFA via POST /auth/mfa/enroll and confirm it via POST /auth/mfa/confirm before calling this endpoint.',
      });
    }
  }
}
