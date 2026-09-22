import { Money } from '../../domain/value-objects/money.vo';
import { PSPProvider } from '../../domain/aggregates/payment.aggregate';
import { PSPHealthStatus } from '../../domain/services/smart-routing.strategy';

export interface PSPChargeRequest {
  paymentId: string;
  idempotencyKey: string;
  amount: Money;
  currency: string;
  merchantId: string;
  customerId?: string;
  description?: string;
  statementDescriptor?: string;
  cardToken?: string;
  paymentMethodId?: string;
  /**
   * Card-issuing country, if known — forwarded as a hint for the PSP's own
   * SCA/3DS decision (e.g. PSD2 requires a challenge for European cards).
   * This does not decide anything on our side; the PSP's charge response is
   * what actually determines whether a challenge is required. See
   * PaymentCheckoutSaga's docblock for why nothing pre-empts that decision
   * before calling the PSP.
   */
  binCountry?: string;
  metadata?: Record<string, string>;
  /** 'manual' authorizes without capturing funds; caller must call capture() separately. */
  captureMethod?: 'automatic' | 'manual';
  threeDSData?: {
    eci: string;
    cavv: string;
    xid?: string;
  };
}

/**
 * The PSP's own transaction-level fraud/risk signal — Stripe Radar's
 * `Charge.outcome`, Adyen's `fraudResult` — surfaced rather than
 * discarded. Deliberately a normalized *union* of two different real
 * vocabularies, not a lowest-common-denominator reduction: `riskLevel`
 * only ever comes from Stripe (Radar's own `normal`/`elevated`/`highest`
 * categorization); `riskScore` only ever comes from Adyen in practice
 * (`fraudResult.accountScore`) since Stripe's numeric `risk_score` is
 * gated behind Radar for Fraud Teams, a paid tier this system has no way
 * to know a given Stripe account has — a PSP that doesn't populate a
 * field simply leaves it undefined rather than this adapter inventing a
 * value. See `PaymentAggregate.calculateRiskScore()` for how this feeds
 * into this platform's own risk tiering as a complementary signal, not
 * a replacement for it — this system sits in front of Stripe/Adyen as
 * the actual card-network processor, so re-deriving card-present fraud
 * detection from scratch would be redundant with what the PSP already
 * computes at network scale; this system's own heuristics stay focused
 * on what the PSP has no visibility into (marketplace/payout/reserve
 * risk), and *ingest* the PSP's signal rather than ignore it.
 */
export interface PSPRiskSignal {
  /** Stripe Radar's own categorization — undefined for Adyen and for any PSP call that doesn't reach a real Charge attempt (e.g. a 3DS redirect never gets this far). */
  riskLevel?: 'normal' | 'elevated' | 'highest';
  /** 0-100, higher = more suspicious, for both PSPs that populate it — but see this interface's own docblock for which PSP populates which field in practice. */
  riskScore?: number;
}

export interface PSPChargeResponse {
  success: boolean;
  transactionId: string;
  status: 'SUCCEEDED' | 'REQUIRES_ACTION' | 'REQUIRES_CAPTURE' | 'FAILED';
  actionUrl?: string; // 3DS redirect URL
  rawResponse: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  riskSignal?: PSPRiskSignal;
}

export interface PSPRefundRequest {
  paymentId: string;
  pspTransactionId: string;
  refundId: string;
  amount: Money;
  reason: string;
  idempotencyKey: string;
}

export interface PSPRefundResponse {
  success: boolean;
  pspRefundId: string;
  status: 'SUCCEEDED' | 'PENDING' | 'FAILED';
  rawResponse: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export interface PSPCaptureRequest {
  paymentId: string;
  pspTransactionId: string;
  amount: Money;
  idempotencyKey: string;
}

export interface PSPCaptureResponse {
  success: boolean;
  pspCaptureId: string;
  rawResponse: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export interface PSPCancelRequest {
  paymentId: string;
  pspTransactionId: string;
  idempotencyKey: string;
}

export interface PSPCancelResponse {
  success: boolean;
  rawResponse: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export interface PSPDisputeEvidenceResponse {
  success: boolean;
  rawResponse: Record<string, unknown>;
  errorMessage?: string;
}

export interface PSPVerifyPaymentMethodRequest {
  paymentMethodId: string;
  merchantId: string;
  /** Only used to pick a PSP that actually supports this currency (via smart routing) and for the PSP's own risk scoring — no money moves regardless of what's passed here. */
  currency: string;
  idempotencyKey: string;
}

export interface PSPVerifyPaymentMethodResponse {
  success: boolean;
  pspVerificationId?: string;
  rawResponse: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * A single settled transaction as reported by the PSP itself — e.g. one row
 * of Stripe's balance transactions or one line of an Adyen settlement
 * report. This is the PSP's own record of what actually moved funds,
 * independent of anything this system wrote to its own ledger — the whole
 * point of reconciliation is comparing the two.
 */
export interface PSPSettlementTransaction {
  pspTransactionId: string;
  amount: Money;
  settledAt: Date;
}

export interface PSPFeeStatement {
  totalFeeMinorUnits: bigint;
  transactionCount: number;
}

export interface PSPQueryOutcomeResult {
  outcome: 'SUCCEEDED' | 'FAILED' | 'STILL_UNKNOWN';
  pspTransactionId?: string;
  errorCode?: string;
  rawResponse?: Record<string, unknown>;
}

/**
 * PSP Adapter Port (Outbound)
 * Defines the contract for Payment Service Provider integrations.
 * Each PSP (Stripe, Adyen, PayPal, Chase) implements this interface.
 */
export abstract class PSPAdapterPort {
  abstract readonly provider: PSPProvider;

  abstract charge(request: PSPChargeRequest): Promise<PSPChargeResponse>;
  abstract refund(request: PSPRefundRequest): Promise<PSPRefundResponse>;
  abstract capture(request: PSPCaptureRequest): Promise<PSPCaptureResponse>;
  abstract cancel(request: PSPCancelRequest): Promise<PSPCancelResponse>;

  /**
   * Confirms a stored payment method is real and chargeable *without*
   * moving money — Stripe's real SetupIntent primitive, or a zero-value
   * authorization (the pattern real Adyen supports for verifying a
   * stored payment method). Used by SubscriptionService before starting
   * a trial, so an invalid or already-revoked `paymentMethodId` is
   * caught at trial signup instead of only discovered weeks later when
   * the trial tries to convert to a real charge.
   */
  abstract verifyPaymentMethod(request: PSPVerifyPaymentMethodRequest): Promise<PSPVerifyPaymentMethodResponse>;

  abstract getHealthStatus(): Promise<PSPHealthStatus>;
  abstract isAvailable(): Promise<boolean>;

  /**
   * Asks the PSP what actually happened to a request that was sent with
   * this idempotency key but never got a response back (see
   * isAmbiguousOutcomeError()) — a read-only lookup, not a new charge
   * attempt. Deliberately doesn't need the original payment method reference:
   * this system never persists cardToken/paymentMethodId past the
   * original request (PCI scope reduction), so any automated
   * resolution path has to work from the idempotency key alone.
   * STILL_UNKNOWN means the PSP has no record either — the original
   * request may genuinely never have reached it.
   */
  abstract queryOutcome(idempotencyKey: string): Promise<PSPQueryOutcomeResult>;

  /**
   * Fetches the PSP's own settlement record for a time window — its
   * independent source of truth for what actually charged, used by
   * ReconciliationService to catch ledger bugs that unit/e2e tests can't
   * (both would need to already be wrong the same way to miss it).
   */
  abstract fetchSettlementTransactions(since: Date, until: Date): Promise<PSPSettlementTransaction[]>;

  /**
   * The PSP's own real fee invoice for a window — PspCostReconciliationService's
   * "actual" side, fetched for real rather than requiring an operator to
   * type in a number from a statement by hand. Real Stripe exposes this
   * via `fee_details` on each balance transaction (or the Reporting API);
   * real Adyen via its settlement batch reports. mock-psp's `/statement`
   * endpoints simulate the same thing with a real, deterministic
   * per-transaction fee that includes a "premium card" surcharge on a
   * fifth of transactions — so this genuinely diverges from
   * PspFeeScheduleService's flat-rate routing estimate, the same way a
   * real interchange bill would, rather than always matching it exactly.
   */
  abstract fetchFeeStatement(since: Date, until: Date, currency: string): Promise<PSPFeeStatement>;

  /**
   * Representment — submits evidence to contest a dispute at the PSP.
   * `pspDisputeId` is the PSP's own id for the dispute (Stripe: `dp_...`;
   * Adyen: the chargeback notification's own pspReference), not the
   * original payment's transaction id.
   */
  abstract submitDisputeEvidence(pspDisputeId: string, evidence: string): Promise<PSPDisputeEvidenceResponse>;
}
