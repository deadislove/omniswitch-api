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
 * 1. BIN country (geographic routing)
 * 2. Transaction amount (fee optimization)
 * 3. Real-time PSP health (circuit breaker state)
 * 4. Currency support
 * 5. Merchant preferences
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
    const availableProviders = this.filterAvailableProviders(context, pspHealthMap);

    if (availableProviders.length === 0) {
      throw new Error(
        `No available PSP providers for currency ${context.amount.currency.code} ` +
        `from country ${context.binInfo?.country ?? 'UNKNOWN'}`,
      );
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

    // 5. Preferred provider bonus
    if (context.preferredProvider === health.provider) score += 20;

    // 6. Geographic preference
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
