import { SetMetadata } from '@nestjs/common';

export enum UserRole {
  ADMIN = 'ADMIN',
  MERCHANT = 'MERCHANT',
  OPERATOR = 'OPERATOR',
  READONLY = 'READONLY',
  /**
   * An autonomous agent acting under a Delegation (see delegation.aggregate.ts)
   * — a narrow, revocable, spend-policy-limited credential issued by a
   * MERCHANT, not the merchant's own full-access role. Deliberately not
   * granted on any route except POST /payments/charge (see that
   * controller's @Roles()) — an agent token has no business calling
   * refund/capture/admin endpoints, which is the point of delegation being
   * a distinct, narrower relationship than authentication.
   */
  AGENT = 'AGENT',
}

export const ROLES_KEY = 'roles';

/**
 * @Roles() decorator
 * Specifies which roles are allowed to access a route.
 * Used with RolesGuard.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
