import { Money } from '../value-objects/money.vo';
import { BinInfo } from '../value-objects/bin-info.vo';
import { PSPProvider } from '../aggregates/payment.aggregate';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface PSPHealthStatus {
  provider: PSPProvider;
  circuitBreakerState: CircuitBreakerState;
  successRate: number;       // 0-100 percentage
  avgLatencyMs: number;
  feePercentage: number;     // e.g., 2.9 for 2.9%
  fixedFeeMinorUnits: number; // e.g., 30 for $0.30
  supportedCurrencies: string[];
  supportedCountries: string[];
  isAvailable: boolean;
}

export interface RoutingContext {
  amount: Money;
  binInfo?: BinInfo;
  merchantId: string;
  preferredProvider?: PSPProvider;
  /**
   * PSPs this merchant is entitled to route through (MerchantEntity.
   * enabledPspProviders) — undefined means "no restriction," the only
   * behavior that existed before this field, so a caller that doesn't
   * attach entitlement info (e.g. SubscriptionService's payment-method
   * verification, which never goes through PaymentCheckoutSaga) is
   * unaffected. When set, it filters the general candidate pool in
   * filterAvailableProviders() *and* is checked against preferredProvider
   * up front in selectProvider() — see PreferredProviderNotEntitledError.
   */
  entitledProviders?: PSPProvider[];
}

/**
 * Thrown by selectProvider() when the caller explicitly requested a
 * preferredProvider the merchant isn't entitled to use. Deliberately a
 * distinct, named error rather than folding this into the generic "no
 * available PSP providers" Error filterAvailableProviders() throws — an
 * entitlement violation is a permission boundary an operator configured on
 * purpose, not "this PSP happens to be down" or "doesn't support this
 * currency," and callers (PaymentCheckoutSaga) need to tell them apart to
 * respond 422 instead of silently falling back to a different PSP the
 * caller never asked for. A plain class, not a NestJS HttpException — this
 * file is pure domain logic with zero framework dependencies (see the
 * class docblock below); the application layer maps this to an HTTP status.
 */
export class PreferredProviderNotEntitledError extends Error {
  constructor(public readonly provider: PSPProvider) {
    super(`Merchant is not entitled to route through ${provider}`);
    this.name = 'PreferredProviderNotEntitledError';
  }
}

export interface RoutingDecision {
  selectedProvider: PSPProvider;
  fallbackProviders: PSPProvider[];
  estimatedFee: Money;
  routingReason: string;
  score: number;
}

/**
 * Smart Routing Strategy (Domain Service)
 * Selects the optimal PSP adapter based on:
 * 1. Merchant preference (`preferredProvider`) — a true override once the
 *    preferred PSP passes the availability/currency/country filter below,
 *    not one more input competing on score. See `selectProvider()`.
 * 2. BIN country (geographic routing)
 * 3. Transaction amount (fee optimization)
 * 4. Real-time PSP health (circuit breaker state)
 * 5. Currency support
 *
 * Zero external dependencies - pure domain logic.
 */
export class SmartRoutingStrategy {
  /**
   * Select the optimal PSP for a given payment context.
   */
  selectProvider(
    context: RoutingContext,
    pspHealthMap: Map<PSPProvider, PSPHealthStatus>,
  ): RoutingDecision {
    // Checked before the general availability filter, and raised as a
    // distinct error rather than left to fall through to scoring —
    // entitlement is an explicit permission boundary, so a caller asking
    // for a PSP outside it should be told clearly, not silently rerouted.
    // (Unlike this, a preferred PSP that merely fails the availability/
    // currency/country filter below *does* fall through to scoring the
    // rest — that's an infrastructure/technical constraint, not a
    // permission one.)
    if (
      context.preferredProvider &&
      context.entitledProviders &&
      !context.entitledProviders.includes(context.preferredProvider)
    ) {
      throw new PreferredProviderNotEntitledError(context.preferredProvider);
    }

    const availableProviders = this.filterAvailableProviders(context, pspHealthMap);

    if (availableProviders.length === 0) {
      throw new Error(
        `No available PSP providers for currency ${context.amount.currency.code} ` +
        `from country ${context.binInfo?.country ?? 'UNKNOWN'}`,
      );
    }

    // preferredProvider is a true override, not a scoring nudge — the
    // charge DTO's own Swagger docs promise "overrides smart routing",
    // and the prior scoring-based behavior (a +20 bonus competing
    // against circuit-breaker state/success-rate/latency/fee) could
    // still send a caller-specified preference to a *different* PSP
    // than requested. Only when the preferred provider isn't currently
    // viable (excluded by the availability/currency/country filter
    // above) does this fall through to normal competitive scoring
    // among what's left.
    if (context.preferredProvider && availableProviders.includes(context.preferredProvider)) {
      const health = pspHealthMap.get(context.preferredProvider)!;
      const score = this.scoreProvider(context, health);
      const fallbacks = availableProviders
        .filter((provider) => provider !== context.preferredProvider)
        .map((provider) => ({ provider, score: this.scoreProvider(context, pspHealthMap.get(provider)!) }))
        .sort((a, b) => b.score - a.score)
        .map((s) => s.provider);

      return {
        selectedProvider: context.preferredProvider,
        fallbackProviders: fallbacks,
        estimatedFee: this.calculateFee(context.amount, health),
        routingReason: `Selected ${context.preferredProvider} (explicit preferredProvider override)`,
        score,
      };
    }

    // Score each provider
    const scored = availableProviders.map((provider) => ({
      provider,
      score: this.scoreProvider(context, pspHealthMap.get(provider)!),
      health: pspHealthMap.get(provider)!,
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    const fallbacks = scored.slice(1).map((s) => s.provider);

    const estimatedFee = this.calculateFee(context.amount, best.health);

    return {
      selectedProvider: best.provider,
      fallbackProviders: fallbacks,
      estimatedFee,
      routingReason: this.buildRoutingReason(context, best.health, best.score),
      score: best.score,
    };
  }

  private filterAvailableProviders(
    context: RoutingContext,
    pspHealthMap: Map<PSPProvider, PSPHealthStatus>,
  ): PSPProvider[] {
    const currency = context.amount.currency.code;
    const country = context.binInfo?.country;

    return Array.from(pspHealthMap.entries())
      .filter(([, health]) => {
        // Must be available and circuit not OPEN
        if (!health.isAvailable || health.circuitBreakerState === 'OPEN') {
          return false;
        }
        // Must be a PSP this merchant is entitled to use, if entitlement
        // info was attached — undefined means no restriction (see
        // RoutingContext.entitledProviders's docblock).
        if (context.entitledProviders && !context.entitledProviders.includes(health.provider)) {
          return false;
        }
        // Must support the currency
        if (!health.supportedCurrencies.includes(currency)) {
          return false;
        }
        // Must support the country (if BIN info available)
        if (country && health.supportedCountries.length > 0) {
          if (!health.supportedCountries.includes(country) && !health.supportedCountries.includes('*')) {
            return false;
          }
        }
        return true;
      })
      .map(([provider]) => provider);
  }

  private scoreProvider(context: RoutingContext, health: PSPHealthStatus): number {
    let score = 0;

    // 1. Circuit breaker state (highest priority)
    if (health.circuitBreakerState === 'CLOSED') score += 40;
    else if (health.circuitBreakerState === 'HALF_OPEN') score += 10;

    // 2. Success rate (0-30 points)
    score += (health.successRate / 100) * 30;

    // 3. Latency score (0-15 points) - lower is better
    const latencyScore = Math.max(0, 15 - (health.avgLatencyMs / 100));
    score += latencyScore;

    // 4. Fee optimization (0-15 points) - lower fee = higher score
    const feeAmount = this.calculateFee(context.amount, health);
    const feeRatio = feeAmount.amount / context.amount.amount;
    const feeScore = Math.max(0, 15 - (feeRatio * 100));
    score += feeScore;

    // Note: no preferredProvider bonus here — it's now a true override
    // handled in selectProvider() before scoring ever runs, not a
    // competing input. This scoring pass is only reached when there's no
    // preference, or the preferred provider already failed the
    // availability filter (so it's never among the candidates being
    // scored here either way).

    // 5. Geographic preference
    if (context.binInfo) {
      if (context.binInfo.isEuropean() && health.provider === 'ADYEN') score += 10;
      if (!context.binInfo.isEuropean() && health.provider === 'STRIPE') score += 5;
    }

    return Math.round(score);
  }

  private calculateFee(amount: Money, health: PSPHealthStatus): Money {
    const percentageFee = amount.multiply(health.feePercentage / 100);
    const fixedFee = Money.fromMinorUnits(health.fixedFeeMinorUnits, amount.currency.code);
    return percentageFee.add(fixedFee);
  }

  private buildRoutingReason(
    context: RoutingContext,
    health: PSPHealthStatus,
    score: number,
  ): string {
    const parts: string[] = [
      `Selected ${health.provider} (score: ${score})`,
      `CB: ${health.circuitBreakerState}`,
      `Success: ${health.successRate}%`,
      `Latency: ${health.avgLatencyMs}ms`,
    ];

    if (context.binInfo) {
      parts.push(`BIN country: ${context.binInfo.country}`);
    }

    return parts.join(', ');
  }
}
