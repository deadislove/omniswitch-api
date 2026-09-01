/**
 * Payment Status Value Object
 * Represents the lifecycle state of a payment with valid transitions.
 */
export enum PaymentStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  REQUIRES_ACTION = 'REQUIRES_ACTION',   // 3DS challenge required
  REQUIRES_CAPTURE = 'REQUIRES_CAPTURE', // Auth succeeded, awaiting capture
  PARTIALLY_CAPTURED = 'PARTIALLY_CAPTURED', // Some, but not all, of the authorized amount has been captured
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  // A PSP call that got no response at all (timeout/network failure before
  // any HTTP response), retried once via the PSP's own idempotency-key
  // replay guarantee and still inconclusive. Distinct from FAILED: FAILED
  // means the PSP explicitly declined, AMBIGUOUS means we genuinely don't
  // know whether the charge went through — reconciliation must resolve it.
  AMBIGUOUS = 'AMBIGUOUS',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  DISPUTED = 'DISPUTED',
}

const VALID_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  // FAILED is reachable directly from PENDING because the saga can fail
  // before ever reaching a PSP (e.g. no PSP available for the currency/
  // country). Without it, PaymentCheckoutSaga.compensate_markFailed() throws
  // on assertValidTransition, the exception is swallowed, and the payment is
  // silently stuck in PENDING forever with no failure ever recorded.
  [PaymentStatus.PENDING]: [PaymentStatus.PROCESSING, PaymentStatus.FAILED, PaymentStatus.CANCELLED],
  [PaymentStatus.PROCESSING]: [
    PaymentStatus.REQUIRES_ACTION,
    PaymentStatus.REQUIRES_CAPTURE,
    PaymentStatus.SUCCEEDED,
    PaymentStatus.FAILED,
    PaymentStatus.AMBIGUOUS,
  ],
  [PaymentStatus.REQUIRES_ACTION]: [
    PaymentStatus.PROCESSING,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ],
  [PaymentStatus.REQUIRES_CAPTURE]: [
    PaymentStatus.SUCCEEDED,
    PaymentStatus.PARTIALLY_CAPTURED,
    PaymentStatus.CANCELLED,
  ],
  // Deliberately can't reach CANCELLED from here: once any capture has
  // happened, "cancel" would mean "void the remaining authorization" — a
  // different operation from voiding an untouched auth (REQUIRES_CAPTURE ->
  // CANCELLED above) that isn't implemented. Attempting it fails loudly via
  // isValidTransition rather than silently doing nothing.
  [PaymentStatus.PARTIALLY_CAPTURED]: [PaymentStatus.SUCCEEDED],
  [PaymentStatus.SUCCEEDED]: [
    PaymentStatus.REFUNDED,
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.DISPUTED,
  ],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.AMBIGUOUS]: [PaymentStatus.SUCCEEDED, PaymentStatus.FAILED],
  [PaymentStatus.CANCELLED]: [],
  [PaymentStatus.REFUNDED]: [],
  // DISPUTED is reachable from here too — a chargeback on a payment that's
  // already been partially refunded is a normal real-world sequence (a
  // partial refund for a shipping issue, the cardholder disputes the rest
  // anyway), not an edge case to leave unmodeled. See
  // PaymentAggregate.resolveDispute()'s own comment for how WON/LOST both
  // account for the refund history already present when the dispute
  // started, rather than assuming a dispute always starts from a clean
  // SUCCEEDED payment.
  [PaymentStatus.PARTIALLY_REFUNDED]: [PaymentStatus.REFUNDED, PaymentStatus.DISPUTED],
  // PARTIALLY_REFUNDED is a valid target here (not just SUCCEEDED) for the
  // same reason — winning a dispute that started from a partially-refunded
  // payment should restore that same partially-refunded state, not
  // silently erase the refund history by resetting to SUCCEEDED.
  [PaymentStatus.DISPUTED]: [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED],
};

export function isValidTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertValidTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `Invalid payment status transition: ${from} -> ${to}. ` +
      `Allowed transitions from ${from}: [${VALID_TRANSITIONS[from]?.join(', ') || 'none'}]`,
    );
  }
}
