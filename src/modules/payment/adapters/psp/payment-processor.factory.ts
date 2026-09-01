import { Injectable, Logger } from '@nestjs/common';
import { PSPAdapterPort } from '../../ports/outbound/psp-adapter.port';
import { PSPProvider } from '../../domain/aggregates/payment.aggregate';
import { SmartRoutingStrategy, RoutingContext, RoutingDecision, PSPHealthStatus } from '../../domain/services/smart-routing.strategy';
import { StripePSPAdapter } from './stripe/stripe-psp.adapter';
import { AdyenPSPAdapter } from './adyen/adyen-psp.adapter';

/**
 * True when `err` was thrown by a PSP adapter's makeRequest() after
 * getting no response at all (a timeout or lower-level network failure)
 * rather than an explicit decline — see StripePSPAdapter/AdyenPSPAdapter's
 * makeRequest(). A plain shape check, not `instanceof`, since the error is
 * a tagged plain Error (Object.assign), not a dedicated error class.
 */
export function isAmbiguousOutcomeError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { isAmbiguousOutcome?: boolean }).isAmbiguousOutcome);
}

/**
 * True when `err` was thrown because the PSP responded with its own 5xx
 * server error — a response WAS received (unlike isAmbiguousOutcomeError,
 * this is not "we don't know what happened"), but it reflects a problem
 * in the PSP's own infrastructure, not a business decision about this
 * charge. Contrast a 4xx (e.g. a declined card): that's the PSP's
 * deliberate, final answer and must never be retried. HTTP status code
 * semantics (RFC 9110) are the PSP's own classification here, not a
 * guess — 5xx always means "the server failed to process a seemingly
 * valid request," never "the request was rejected." Both PSP adapters'
 * makeRequest() already attach statusCode to the error they throw on a
 * non-ok response; this just reads it.
 */
export function isTransientPspError(err: unknown): boolean {
  const statusCode = err && typeof err === 'object' ? (err as { statusCode?: unknown }).statusCode : undefined;
  return typeof statusCode === 'number' && statusCode >= 500;
}

/**
 * Payment Processor Factory
 * Implements the Factory Pattern to dynamically instantiate and select
 * the correct PSP adapter at runtime based on:
 * 1. Merchant configuration
 * 2. Smart routing decision (BIN, amount, PSP health)
 * 3. Fallback chain on failure
 */
@Injectable()
export class PaymentProcessorFactory {
  private readonly logger = new Logger(PaymentProcessorFactory.name);
  private readonly adapters: Map<PSPProvider, PSPAdapterPort>;
  private readonly routingStrategy: SmartRoutingStrategy;

  constructor(
    private readonly stripeAdapter: StripePSPAdapter,
    private readonly adyenAdapter: AdyenPSPAdapter,
  ) {
    this.adapters = new Map<PSPProvider, PSPAdapterPort>([
      ['STRIPE', stripeAdapter],
      ['ADYEN', adyenAdapter],
    ]);
    this.routingStrategy = new SmartRoutingStrategy();
  }

  /**
   * Get a specific PSP adapter by provider name.
   * Used when the provider is already determined.
   */
  getAdapter(provider: PSPProvider): PSPAdapterPort {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`No PSP adapter registered for provider: ${provider}`);
    }
    return adapter;
  }

  /**
   * Dynamically select the optimal PSP adapter using Smart Routing.
   * Returns the routing decision along with the selected adapter.
   */
  async selectAdapter(context: RoutingContext): Promise<{
    adapter: PSPAdapterPort;
    decision: RoutingDecision;
  }> {
    // Collect real-time health status from all adapters
    const pspHealthMap = new Map<PSPProvider, PSPHealthStatus>();

    for (const [provider, adapter] of this.adapters) {
      try {
        const health = await adapter.getHealthStatus();
        pspHealthMap.set(provider, health);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to get health status for ${provider}: ${msg}`);
        // Mark as unavailable if health check fails
        pspHealthMap.set(provider, {
          provider,
          circuitBreakerState: 'OPEN',
          successRate: 0,
          avgLatencyMs: 9999,
          feePercentage: 99,
          fixedFeeMinorUnits: 9999,
          supportedCurrencies: [],
          supportedCountries: [],
          isAvailable: false,
        });
      }
    }

    const decision = this.routingStrategy.selectProvider(context, pspHealthMap);
    const adapter = this.getAdapter(decision.selectedProvider);

    this.logger.log(
      `Smart routing decision: ${decision.routingReason} | ` +
      `Fallbacks: [${decision.fallbackProviders.join(', ')}]`,
    );

    return { adapter, decision };
  }

  /**
   * Get adapter with automatic fallback chain.
   * Tries primary provider, then falls back to alternatives on failure.
   */
  async executeWithFallback<T>(
    context: RoutingContext,
    operation: (adapter: PSPAdapterPort) => Promise<T>,
  ): Promise<{ result: T; provider: PSPProvider; usedFallback: boolean }> {
    const { adapter, decision } = await this.selectAdapter(context);

    // Try primary provider
    let primaryError: unknown;
    try {
      const result = await operation(adapter);
      return { result, provider: decision.selectedProvider, usedFallback: false };
    } catch (err: unknown) {
      primaryError = err;
    }

    // An ambiguous primary outcome (PSP call got no response at all) must
    // NEVER fall through to a different PSP: that PSP has never seen this
    // idempotency key and would process a genuinely new charge, risking a
    // double charge if the ambiguous attempt actually succeeded. A
    // transient PSP-side 5xx carries no such double-charge risk on its
    // own (a response was received, so we know this attempt didn't
    // silently succeed) — it's included here anyway, for the same
    // idempotency-key-replay safety margin, since a struggling PSP is
    // often good again a moment later and retrying the SAME provider
    // first (rather than immediately routing a fresh attempt to a PSP
    // that's never seen this idempotency key) is the more conservative
    // choice. Retry the SAME provider once — its own idempotency-key
    // replay guarantee returns the original result if it already went
    // through, or safely reprocesses if it didn't. Only once the outcome
    // resolves to a definite decline (or a repeat of either failure
    // class above) is it safe to consider a fallback.
    if (isAmbiguousOutcomeError(primaryError) || isTransientPspError(primaryError)) {
      const retryReason = isAmbiguousOutcomeError(primaryError) ? 'outcome ambiguous' : 'returned a transient server error';
      this.logger.warn(
        `Primary PSP ${decision.selectedProvider} ${retryReason} — retrying the same provider once via idempotency replay before considering any fallback`,
      );
      try {
        const result = await operation(adapter);
        return { result, provider: decision.selectedProvider, usedFallback: false };
      } catch (retryError: unknown) {
        if (isAmbiguousOutcomeError(retryError)) {
          throw Object.assign(
            new Error(`${decision.selectedProvider} outcome remains ambiguous after one retry.`),
            { isAmbiguousOutcome: true },
          );
        }
        // A retry that resolves to a transient 5xx again (or now a 4xx
        // decline) is a confirmed, non-ambiguous failure — safe to fall
        // through to the normal fallback loop below.
        primaryError = retryError;
      }
    }

    const primaryMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
    this.logger.warn(
      `Primary PSP ${decision.selectedProvider} failed: ${primaryMsg}. ` +
      `Trying fallbacks: [${decision.fallbackProviders.join(', ')}]`,
    );

    // Tracks whether the most recent attempt (primary, or whichever
    // fallback was tried last) ended in an ambiguous outcome — a PSP
    // call that got no response at all, see StripePSPAdapter/
    // AdyenPSPAdapter's makeRequest() — rather than an explicit decline.
    // Carried onto the aggregate error below so a caller can distinguish
    // "every PSP explicitly said no" from "we lost track of whether the
    // last attempt actually went through."
    let lastFailureWasAmbiguous = isAmbiguousOutcomeError(primaryError);

    // Try fallback providers. No same-provider-retry-before-next-fallback
    // logic here (unlike the primary above) since only 2 PSPs (STRIPE/
    // ADYEN) are registered today — there's nothing to retry-before-fall-
    // back to once we're already in the fallback loop.
    for (const fallbackProvider of decision.fallbackProviders) {
      const fallbackAdapter = this.getAdapter(fallbackProvider);
      const isAvailable = await fallbackAdapter.isAvailable();

      if (!isAvailable) {
        this.logger.warn(`Fallback ${fallbackProvider} is not available, skipping`);
        continue;
      }

      try {
        const result = await operation(fallbackAdapter);
        this.logger.log(`Fallback to ${fallbackProvider} succeeded`);
        return { result, provider: fallbackProvider, usedFallback: true };
      } catch (fallbackError: unknown) {
        const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        this.logger.warn(`Fallback ${fallbackProvider} also failed: ${fallbackMsg}`);
        lastFailureWasAmbiguous = isAmbiguousOutcomeError(fallbackError);
      }
    }

    // All providers failed
    throw Object.assign(
      new Error(
        `All PSP providers failed. Primary: ${decision.selectedProvider}. ` +
        `Fallbacks tried: [${decision.fallbackProviders.join(', ')}]`,
      ),
      { isAmbiguousOutcome: lastFailureWasAmbiguous },
    );
  }

  /**
   * Get all registered providers
   */
  getRegisteredProviders(): PSPProvider[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Get health status of all PSP adapters
   */
  async getAllHealthStatuses(): Promise<Map<PSPProvider, PSPHealthStatus>> {
    const statuses = new Map<PSPProvider, PSPHealthStatus>();
    for (const [provider, adapter] of this.adapters) {
      try {
        statuses.set(provider, await adapter.getHealthStatus());
      } catch {
        statuses.set(provider, {
          provider,
          circuitBreakerState: 'OPEN',
          successRate: 0,
          avgLatencyMs: 9999,
          feePercentage: 99,
          fixedFeeMinorUnits: 9999,
          supportedCurrencies: [],
          supportedCountries: [],
          isAvailable: false,
        });
      }
    }
    return statuses;
  }
}
