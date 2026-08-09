import { Injectable, Logger } from '@nestjs/common';
import { PaymentProcessorFactory } from '../../adapters/psp/payment-processor.factory';
import { SmartRoutingStrategy, RoutingContext, RoutingDecision } from '../../domain/services/smart-routing.strategy';
import { Money } from '../../domain/value-objects/money.vo';
import { BinInfo } from '../../domain/value-objects/bin-info.vo';
import { PSPProvider } from '../../domain/aggregates/payment.aggregate';
import { PSPAdapterPort } from '../../ports/outbound/psp-adapter.port';

/**
 * Acquirer Routing Service (Application Layer)
 * Orchestrates PSP selection using the SmartRoutingStrategy domain service
 * and the PaymentProcessorFactory.
 *
 * This is the application-layer bridge between domain routing logic
 * and infrastructure PSP adapters.
 */
@Injectable()
export class AcquirerRoutingService {
  private readonly logger = new Logger(AcquirerRoutingService.name);

  constructor(
    private readonly processorFactory: PaymentProcessorFactory,
  ) {}

  /**
   * Select the optimal PSP adapter for a payment.
   */
  async selectOptimalAdapter(params: {
    amount: Money;
    binInfo?: BinInfo;
    merchantId: string;
    preferredProvider?: PSPProvider;
  }): Promise<{ adapter: PSPAdapterPort; decision: RoutingDecision }> {
    const context: RoutingContext = {
      amount: params.amount,
      binInfo: params.binInfo,
      merchantId: params.merchantId,
      preferredProvider: params.preferredProvider,
    };

    const result = await this.processorFactory.selectAdapter(context);

    this.logger.log(
      `[AcquirerRouting] Selected ${result.decision.selectedProvider} ` +
      `for merchant=${params.merchantId}, ` +
      `amount=${params.amount.toString()}, ` +
      `score=${result.decision.score}`,
    );

    return result;
  }

  /**
   * Execute a PSP operation with automatic smart routing and fallback.
   */
  async executeWithSmartRouting<T>(
    params: {
      amount: Money;
      binInfo?: BinInfo;
      merchantId: string;
      preferredProvider?: PSPProvider;
    },
    operation: (adapter: PSPAdapterPort) => Promise<T>,
  ): Promise<{ result: T; provider: PSPProvider; usedFallback: boolean }> {
    const context: RoutingContext = {
      amount: params.amount,
      binInfo: params.binInfo,
      merchantId: params.merchantId,
      preferredProvider: params.preferredProvider,
    };

    return this.processorFactory.executeWithFallback(context, operation);
  }

  /**
   * Get current health status of all PSP providers.
   */
  async getPSPHealthSummary(): Promise<Record<string, unknown>> {
    const statuses = await this.processorFactory.getAllHealthStatuses();
    const summary: Record<string, unknown> = {};

    for (const [provider, status] of statuses) {
      summary[provider] = {
        available: status.isAvailable,
        circuitBreaker: status.circuitBreakerState,
        successRate: `${status.successRate}%`,
        avgLatency: `${status.avgLatencyMs}ms`,
        fee: `${status.feePercentage}% + ${status.fixedFeeMinorUnits} minor units`,
      };
    }

    return summary;
  }
}
