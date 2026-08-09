import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, UserRole } from '../decorators/roles.decorator';

/**
 * RBAC Roles Guard
 * Enforces role-based access control on routes decorated with @Roles().
 * Must be used after JwtAuthGuard (requires authenticated user in request).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
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

    return true;
  }
}
