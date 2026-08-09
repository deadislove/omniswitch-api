import { Injectable, Logger } from '@nestjs/common';
import { PSPAdapterPort } from '../../ports/outbound/psp-adapter.port';
import { PSPProvider } from '../../domain/aggregates/payment.aggregate';
import { SmartRoutingStrategy, RoutingContext, RoutingDecision, PSPHealthStatus } from '../../domain/services/smart-routing.strategy';
import { StripePSPAdapter } from './stripe/stripe-psp.adapter';
import { AdyenPSPAdapter } from './adyen/adyen-psp.adapter';

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
    try {
      const result = await operation(adapter);
      return { result, provider: decision.selectedProvider, usedFallback: false };
    } catch (primaryError: unknown) {
      const primaryMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
      this.logger.warn(
        `Primary PSP ${decision.selectedProvider} failed: ${primaryMsg}. ` +
        `Trying fallbacks: [${decision.fallbackProviders.join(', ')}]`,
      );

      // Try fallback providers
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
        }
      }

      // All providers failed
      throw new Error(
        `All PSP providers failed. Primary: ${decision.selectedProvider}. ` +
        `Fallbacks tried: [${decision.fallbackProviders.join(', ')}]`,
      );
    }
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
