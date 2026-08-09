import { SetMetadata } from '@nestjs/common';

export const ALLOW_MFA_PENDING_KEY = 'allowMfaPending';

/**
 * @AllowMfaPending() decorator
 * Marks a route as reachable with an mfaPending JWT (see JwtPayload) —
 * JwtAuthGuard rejects mfaPending tokens everywhere else. Only
 * POST /auth/mfa/verify should ever carry this.
 */
export const AllowMfaPending = () => SetMetadata(ALLOW_MFA_PENDING_KEY, true);
