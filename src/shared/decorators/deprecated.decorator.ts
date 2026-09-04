import { SetMetadata } from '@nestjs/common';

export const DEPRECATED_ROUTE_KEY = 'deprecatedRoute';

export interface DeprecationMetadata {
  /** ISO 8601 date (e.g. '2027-01-01') the route stops working — becomes the `Sunset` header (RFC 8594). */
  sunsetDate: string;
  /** URL of the migration guide for callers still on this route — becomes a `Link: <url>; rel="deprecation"` header. */
  migrationGuideUrl: string;
}

/**
 * Marks a route as deprecated — DeprecationHeaderInterceptor (registered
 * globally in app.module.ts) reads this metadata and adds the real HTTP
 * signals a well-behaved API client can act on (RFC 8594's `Sunset`
 * header, plus a `Deprecation`/`Link` pair following the same shape
 * Stripe/GitHub's own APIs use) — not just a note in a changelog a caller
 * has to know to go read. See docs/technical/api-versioning-policy.md for
 * the SLA this is meant to satisfy (minimum notice period, when it's
 * safe to actually remove the route).
 */
export const Deprecated = (metadata: DeprecationMetadata) => SetMetadata(DEPRECATED_ROUTE_KEY, metadata);
