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

  /**
   * Same as findById(), but forced onto master instead of the ambient
   * replica-routed connection — for internal call sites that look up a
   * payment immediately after writing it (or after another write in the
   * same business flow), where the read genuinely can't tolerate the
   * replica's ~1s streaming lag. Unlike findById() (used by GET
   * /payments/:id and the SSE status stream — read-only, latency-
   * insensitive, fine to serve off the replica), this is for the
   * refund/capture/cancel lookup (PaymentLifecycleService.getOwnedPayment())
   * and dispute-resolution webhook processing (DisputeService's own
   * payment lookup) — see docs/technical/ci-cd.md for the incident this
   * was split out to fix without moving every payment read onto master.
   */
  abstract findByIdOnMaster(id: string): Promise<PaymentAggregate | null>;

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

  /**
   * `AMBIGUOUS` payments (a PSP call that got no response at all, and a
   * same-provider retry also got no response — see
   * PaymentCheckoutSaga.compensate_markAmbiguous()) created more than
   * `olderThanMinutes` ago. Across every merchant, like
   * findByProviderAndDateRange() — an operator resolving these works at
   * the platform level, not scoped to one merchant. Used by
   * AmbiguousPaymentService for both the admin-facing list endpoint and
   * the stale-alert sweep; `olderThanMinutes: 0` returns every currently
   * `AMBIGUOUS` payment regardless of age.
   */
  abstract findAmbiguousOlderThan(olderThanMinutes: number): Promise<PaymentAggregate[]>;

  /**
   * Count of this merchant's payments that were *ever* `AMBIGUOUS` since a
   * point in time — `status = 'AMBIGUOUS' OR ambiguousResolvedAt IS NOT NULL`,
   * not just currently-`AMBIGUOUS`, since AmbiguousPaymentService's manual
   * resolution moves a payment out of `AMBIGUOUS` into `SUCCEEDED`/`FAILED`
   * without erasing the fact that it was, at some point, a real ambiguous
   * incident for this merchant. Used by AmbiguousRiskMonitoringService's
   * rolling-window threshold check.
   */
  abstract countAmbiguousIncidentsSince(merchantId: string, since: Date): Promise<number>;

  /**
   * Whether this merchant was *ever* `AMBIGUOUS` (same definition as
   * countAmbiguousIncidentsSince above), for each of its most recent
   * `limit` payments, newest first. Used by
   * AmbiguousRiskMonitoringService's consecutive-incidents check — a
   * merchant whose last N payments were *all* ambiguous is a stronger,
   * more specific signal than raw volume within a window (a high-volume
   * merchant could rack up many ambiguous incidents during a PSP's bad
   * stretch without every single one of its charges being affected).
   * Shorter than `limit` if the merchant has fewer than `limit` payments
   * total — callers should treat that as "not enough history to trigger
   * this check yet", not as a false streak.
   */
  abstract findRecentAmbiguousFlags(merchantId: string, limit: number): Promise<boolean[]>;

  /**
   * Still-`AMBIGUOUS` payments eligible for
   * AmbiguousPaymentService.runAutoResolutionSweep() to ask the PSP about
   * via queryOutcome(): `ambiguousAutoRetryCount < maxAttempts` (once a
   * payment hits the cap the sweep stops touching it and leaves it for a
   * human via the existing stale-alert path) and old enough
   * (`createdAt <= now - minAgeMinutes`, so the sweep doesn't immediately
   * re-query a PSP that only just failed to respond — the same PSP may
   * still be in the middle of whatever caused the original timeout).
   * Across every merchant, like findAmbiguousOlderThan(). A payment a
   * human already resolved manually is naturally excluded: its status is
   * no longer `AMBIGUOUS` once AmbiguousPaymentService.resolve() runs.
   */
  abstract findAmbiguousEligibleForAutoResolution(maxAttempts: number, minAgeMinutes: number): Promise<PaymentAggregate[]>;
}
