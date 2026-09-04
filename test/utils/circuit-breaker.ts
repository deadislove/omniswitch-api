import { INestApplication } from '@nestjs/common';
import { CachePort } from '../../src/modules/payment/ports/outbound/cache.port';

/**
 * Resets a PSP provider's circuit-breaker state in Redis. Needed both
 * before and after any e2e test that deliberately trips a circuit breaker
 * OPEN: this state is shared across every e2e spec file that a given Jest
 * worker happens to run (test/setup-env.ts gives each worker its own
 * Redis DB, but files within one worker still run sequentially against
 * that same DB with no flush between them), so without a reset on both
 * ends, one test's deliberately-tripped breaker leaks into whichever test
 * — in this file or another — that worker runs next and touches the same
 * provider.
 */
export async function resetCircuitBreakerState(app: INestApplication, providers: string[]): Promise<void> {
  const cache = app.get(CachePort);
  await Promise.all(
    providers.flatMap((provider) => [
      cache.del(`circuit:${provider}:recentCallCount`),
      cache.del(`circuit:${provider}:slowCallCount`),
      cache.del(`circuit:${provider}:failureCount`),
      cache.del(`circuit:${provider}:state`),
      cache.del(`circuit:${provider}:lastFailureTime`),
      cache.del(`circuit:${provider}:halfOpenTrialCount`),
    ]),
  );
}
