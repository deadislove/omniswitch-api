import { Money } from '../value-objects/money.vo';

/**
 * One currency's worth of a merchant's activity within a statement
 * period — a merchant can accumulate balances in more than one currency
 * within a single period (same reasoning `PayoutService.runSweepLocked()`
 * already documents for its own per-currency `Payout` split), so one
 * `MerchantStatement` can carry more than one of these.
 *
 * `grossVolumeMinorUnits`/`platformFeeMinorUnits`/`providerFeeMinorUnits`
 * are only computed from this merchant's own *direct* charges (a ledger
 * event with exactly one `MERCHANT`-type entry, attributed to this
 * merchant) — a marketplace split shares one charge event across
 * multiple merchants with no way to attribute a single party's "share
 * of the pre-fee gross," so a split-sourced credit/debit is deliberately
 * kept out of this breakdown and surfaced separately as
 * `marketplaceSplitProceedsMinorUnits` instead. See
 * `docs/business-domain/ledger-accounting.md`'s statement section for
 * the full reasoning.
 *
 * `netSettlementMinorUnits` is never derived from the fields above —
 * it's the literal sum of every `MERCHANT`-type ledger entry for this
 * merchant in the period (credits positive, debits negative), the same
 * computation `PayoutService.runSweepLocked()` already trusts as "what
 * the ledger says this merchant's account actually moved by" — so it
 * always reconciles against the real ledger by construction, split
 * proceeds included, independent of whether the breakdown above could
 * fully attribute every contributing event.
 *
 * Signed fields (`netSettlementMinorUnits`,
 * `marketplaceSplitProceedsMinorUnits`) are plain `bigint`/string rather
 * than `Money` — `Money` rejects a negative amount by construction (see
 * its own constructor), and a net balance or split proceeds total can
 * legitimately be negative (a month of refunds with no new charges,
 * a connected merchant reversed more than it was credited).
 */
export interface StatementCurrencyBreakdown {
  currencyCode: string;
  chargeCount: number;
  grossVolume: Money;
  platformFee: Money;
  providerFee: Money;
  refundedAmount: Money;
  chargebackCount: number;
  chargebackAmount: Money;
  marketplaceSplitProceedsMinorUnits: bigint;
  netSettlementMinorUnits: bigint;
}

/**
 * Merchant Statement
 * A periodic (monthly), merchant-facing summary of volume, fees,
 * chargebacks, and net settlement — the document a merchant's own
 * bookkeeper reconciles against, rather than raw ledger/API data they'd
 * otherwise have to aggregate independently themselves. See
 * `MerchantStatementService`'s own docblock for how each breakdown is
 * computed and `docs/business-domain/ledger-accounting.md` for the full
 * writeup.
 *
 * Deliberately a plain record rather than a rich aggregate with
 * invariants to protect — same posture as `ReconciliationRun`/
 * `PayoutSweepRun`: every number here is already real, booked ledger
 * history by the time this is generated, so there's nothing left to
 * enforce once the breakdown is computed. Immutable once generated:
 * `MerchantStatementService.generateForMerchant()` is idempotent on
 * `(merchantId, periodStart, periodEnd)` rather than overwriting an
 * existing statement — a past, closed period's own ledger history
 * doesn't change after the fact (see that service's own docblock for
 * why a late-arriving dispute resolution can't retroactively invalidate
 * an already-generated statement).
 */
export class MerchantStatement {
  private constructor(
    public readonly id: string,
    public readonly merchantId: string,
    public readonly periodStart: Date,
    public readonly periodEnd: Date,
    public readonly breakdowns: StatementCurrencyBreakdown[],
    public readonly generatedAt: Date,
  ) {}

  static create(params: {
    id: string;
    merchantId: string;
    periodStart: Date;
    periodEnd: Date;
    breakdowns: StatementCurrencyBreakdown[];
  }): MerchantStatement {
    return new MerchantStatement(
      params.id,
      params.merchantId,
      params.periodStart,
      params.periodEnd,
      params.breakdowns,
      new Date(),
    );
  }

  static reconstitute(params: {
    id: string;
    merchantId: string;
    periodStart: Date;
    periodEnd: Date;
    breakdowns: StatementCurrencyBreakdown[];
    generatedAt: Date;
  }): MerchantStatement {
    return new MerchantStatement(
      params.id,
      params.merchantId,
      params.periodStart,
      params.periodEnd,
      params.breakdowns,
      params.generatedAt,
    );
  }
}
