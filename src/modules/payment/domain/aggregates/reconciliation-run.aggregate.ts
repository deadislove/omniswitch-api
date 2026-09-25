import { Money } from '../value-objects/money.vo';
import { PSPProvider } from './payment.aggregate';

export type ReconciliationStatus = 'CLEAN' | 'MISMATCHES_FOUND';

export type MismatchType =
  | 'MISSING_AT_PSP' // we booked a charge; the PSP has no matching settlement record
  | 'AMOUNT_MISMATCH' // both sides have the transaction, in the same currency, but the amount differs
  | 'CURRENCY_MISMATCH' // the settled currency differs from what we charged — could be a real bug, or
  // legitimate PSP-side conversion (DCC, cross-border settlement) — needs human judgment either way,
  // deliberately not folded into AMOUNT_MISMATCH since the two warrant different urgency
  | 'UNKNOWN_AT_PSP' // the PSP settled a transaction we have no record of
  | 'COMPARISON_ERROR'; // this one payment's comparison threw unexpectedly — the run continued for
// everything else, but this payment's actual match status is unknown, not confirmed either way

export interface ReconciliationMismatch {
  type: MismatchType;
  paymentId?: string;
  pspTransactionId?: string;
  expectedAmount?: Money;
  actualAmount?: Money;
  description: string;
}

/**
 * Reconciliation Run
 * A record of one comparison between this system's ledger and a PSP's own
 * settlement report for a time window — the safety net for ledger/outbox
 * bugs that unit and e2e tests can't catch, since both would have to be
 * wrong the same way to miss one (see payment-checkout.saga.ts's ledger
 * timing note on the double-booking bug this class of check would catch:
 * reconciliation is exactly the mechanism that catches that kind of drift
 * in a real deployment, faster than "someone eventually notices the books
 * don't add up").
 *
 * Deliberately a plain record, not a rich aggregate with invariants to
 * protect — like LedgerOutboxEvent, it's closer to a structured log entry
 * than a business entity with a lifecycle.
 */
export class ReconciliationRun {
  private constructor(
    public readonly id: string,
    public readonly pspProvider: PSPProvider,
    public readonly windowStart: Date,
    public readonly windowEnd: Date,
    public readonly transactionsChecked: number,
    public readonly mismatches: ReconciliationMismatch[],
    public readonly status: ReconciliationStatus,
    public readonly ranAt: Date,
  ) {}

  static create(params: {
    id: string;
    pspProvider: PSPProvider;
    windowStart: Date;
    windowEnd: Date;
    transactionsChecked: number;
    mismatches: ReconciliationMismatch[];
  }): ReconciliationRun {
    return new ReconciliationRun(
      params.id,
      params.pspProvider,
      params.windowStart,
      params.windowEnd,
      params.transactionsChecked,
      params.mismatches,
      params.mismatches.length > 0 ? 'MISMATCHES_FOUND' : 'CLEAN',
      new Date(),
    );
  }

  static reconstitute(params: {
    id: string;
    pspProvider: PSPProvider;
    windowStart: Date;
    windowEnd: Date;
    transactionsChecked: number;
    mismatches: ReconciliationMismatch[];
    status: ReconciliationStatus;
    ranAt: Date;
  }): ReconciliationRun {
    return new ReconciliationRun(
      params.id,
      params.pspProvider,
      params.windowStart,
      params.windowEnd,
      params.transactionsChecked,
      params.mismatches,
      params.status,
      params.ranAt,
    );
  }
}
