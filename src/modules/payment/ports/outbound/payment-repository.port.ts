import { PaymentAggregate, PSPProvider } from '../../domain/aggregates/payment.aggregate';
import { PaymentStatus } from '../../domain/value-objects/payment-status.vo';

export interface FindPaymentsFilter {
  merchantId?: string;
  status?: PaymentStatus;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Payment Repository Port (Outbound)
 * Defines the contract for payment persistence.
 * Implementations live in the adapters layer.
 */
export abstract class PaymentRepositoryPort {
  abstract save(payment: PaymentAggregate): Promise<void>;
  abstract findById(id: string): Promise<PaymentAggregate | null>;
  abstract findByIdempotencyKey(key: string): Promise<PaymentAggregate | null>;
  abstract findByPspTransactionId(pspTransactionId: string): Promise<PaymentAggregate | null>;
  abstract findByMerchantId(merchantId: string, filter?: FindPaymentsFilter): Promise<PaymentAggregate[]>;
  abstract update(payment: PaymentAggregate): Promise<void>;
  abstract existsById(id: string): Promise<boolean>;
  abstract count(filter?: FindPaymentsFilter): Promise<number>;

  /**
   * Payments charged via a specific PSP within a time window, across every
   * merchant — used by ReconciliationService, which compares against that
   * PSP's own settlement report (a PSP-account-level concept, not scoped to
   * one of our merchants the way findByMerchantId is).
   */
  abstract findByProviderAndDateRange(
    pspProvider: PSPProvider,
    fromDate: Date,
    toDate: Date,
  ): Promise<PaymentAggregate[]>;

  /**
   * Payment volume grouped by (status, pspProvider) across every merchant —
   * used by MetricsController's payment-volume gauge. Deliberately a
   * pull-computed aggregate query, not an in-process counter incremented
   * from PaymentCheckoutSaga's terminal-outcome branches: an in-process
   * `prom-client` Counter is per-pod state, the same shared-state mistake
   * this codebase already fixed for rate limiting (RedisThrottlerStorage)
   * and PSP circuit breakers (RedisCircuitBreakerService) — it would reset
   * on every pod restart and never agree across replicas without its own
   * Redis-backed counter. The `payments` table is already the single
   * authoritative source of this count, so re-deriving it at scrape time
   * can't drift from it, the same reasoning the existing PSP health/outbox
   * backlog gauges already use.
   */
  abstract countByStatusAndProvider(): Promise<{ status: PaymentStatus; pspProvider: PSPProvider | null; count: number }[]>;

  /**
   * Total SUCCEEDED charge volume for a merchant, in a specific currency,
   * since a given point in time — used by ChargeLedgerParamsResolverService
   * to pick a volume-based fee tier from MerchantEntity.feeTiers. Scoped to
   * one currency deliberately: blending amounts across currencies into one
   * "volume" figure would need an FX rate this codebase doesn't apply
   * retroactively to historical charges, so a multi-currency merchant's fee
   * tier is decided per-currency rather than off a blended total.
   */
  abstract sumSucceededVolumeSince(merchantId: string, since: Date, currencyCode: string): Promise<bigint>;
}
