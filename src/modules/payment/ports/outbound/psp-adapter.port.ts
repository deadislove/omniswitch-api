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

export interface PSPChargeResponse {
  success: boolean;
  transactionId: string;
  status: 'SUCCEEDED' | 'REQUIRES_ACTION' | 'REQUIRES_CAPTURE' | 'FAILED';
  actionUrl?: string;       // 3DS redirect URL
  rawResponse: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
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
   * Representment — submits evidence to contest a dispute at the PSP.
   * `pspDisputeId` is the PSP's own id for the dispute (Stripe: `dp_...`;
   * Adyen: the chargeback notification's own pspReference), not the
   * original payment's transaction id.
   */
  abstract submitDisputeEvidence(pspDisputeId: string, evidence: string): Promise<PSPDisputeEvidenceResponse>;
}
