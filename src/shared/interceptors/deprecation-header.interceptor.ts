import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { DEPRECATED_ROUTE_KEY, DeprecationMetadata } from '../decorators/deprecated.decorator';

/**
 * Registered globally (app.module.ts) so `@Deprecated(...)` works on any
 * controller without each one wiring its own interceptor. Adds three
 * headers, all defined by real specs/prior art rather than invented here:
 * `Sunset` (RFC 8594 — the date the route stops working), `Deprecation`
 * (draft-ietf-httpapi-deprecation-header — signals "this is deprecated
 * now", independent of whether a Sunset date is set yet), and `Link:
 * rel="deprecation"` (the same pattern Stripe/GitHub's own APIs use to
 * point a caller at a migration guide instead of leaving them to find one).
 * A no-op on every route without the decorator — reading route metadata
 * per request is cheap compared to the rest of the request pipeline.
 */
@Injectable()
export class DeprecationHeaderInterceptor implements NestInterceptor {
  private readonly logger = new Logger(DeprecationHeaderInterceptor.name);

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const metadata = this.reflector.getAllAndOverride<DeprecationMetadata | undefined>(DEPRECATED_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (metadata) {
      const response = context.switchToHttp().getResponse();
      response.setHeader('Deprecation', 'true');
      response.setHeader('Sunset', new Date(metadata.sunsetDate).toUTCString());
      response.setHeader('Link', `<${metadata.migrationGuideUrl}>; rel="deprecation"`);
      // No traffic metric wired up here (see api-versioning-policy.md's
      // "What this doesn't do" — deliberately not built until a route
      // actually needs it, to avoid a second prom-client Registry
      // instance alongside MetricsController's own). This log line is
      // the interim signal: grep for it against real traffic before
      // treating a route's sunset date as safe to actually enforce.
      this.logger.warn(`Deprecated route called: ${context.getClass().name}.${context.getHandler().name}`);
    }

    return next.handle();
  }
}
