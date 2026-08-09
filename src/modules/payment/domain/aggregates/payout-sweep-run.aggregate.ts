/**
 * Payout Sweep Run
 * A record of one PayoutService.runSweep() invocation — the cursor for
 * "which slice of ledger history has already been swept into a Payout,"
 * and the audit trail for it. Always written, even when zero connected
 * merchants had any activity in the window, so the *next* sweep's `since`
 * (the latest run's `windowEnd`) always advances monotonically — a Payout
 * row alone can't serve as that cursor, since a window with no eligible
 * merchant produces no Payout row at all.
 *
 * Deliberately a plain record, not a rich aggregate with invariants to
 * protect — same posture as `ReconciliationRun`.
 */
export class PayoutSweepRun {
  private constructor(
    public readonly id: string,
    public readonly windowStart: Date,
    public readonly windowEnd: Date,
    public readonly connectedMerchantsPaid: number,
    public readonly ranAt: Date,
  ) {}

  static create(params: {
    id: string;
    windowStart: Date;
    windowEnd: Date;
    connectedMerchantsPaid: number;
  }): PayoutSweepRun {
    return new PayoutSweepRun(params.id, params.windowStart, params.windowEnd, params.connectedMerchantsPaid, new Date());
  }

  static reconstitute(params: {
    id: string;
    windowStart: Date;
    windowEnd: Date;
    connectedMerchantsPaid: number;
    ranAt: Date;
  }): PayoutSweepRun {
    return new PayoutSweepRun(params.id, params.windowStart, params.windowEnd, params.connectedMerchantsPaid, params.ranAt);
  }
}
