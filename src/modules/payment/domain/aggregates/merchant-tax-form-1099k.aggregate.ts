import { Money } from '../value-objects/money.vo';

/**
 * Merchant 1099-K Tax Form
 * A US merchant's annual summary of what a real payment processor must
 * report to the IRS (and furnish a copy of to the merchant) once their
 * settled volume crosses the statutory threshold for a calendar year —
 * see `TaxForm1099KService`'s own docblock for how each field is
 * computed and `docs/technical/compliance-certification-roadmap.md`'s
 * 1099-K section for the full real-vs-modeled scope boundary.
 *
 * **This is a computed, illustrative record — never actually
 * transmitted to the IRS.** Unlike `MatchReportingPort` (a real,
 * mocked external integration this codebase chooses to model end to
 * end), there is deliberately no `IrsFilingPort`/filing lifecycle here:
 * an annual information-return filing is exactly the kind of real
 * compliance deadline this project should be upfront about not
 * actually submitting anything for, rather than inventing a fake
 * confirmation number that would read as more real than it is.
 *
 * `grossAmount` (IRS Box 1a) is deliberately **not** reduced by
 * refunds or chargebacks — that's the real IRS rule (a processor
 * reports the gross amount of reportable payment transactions without
 * regard to any adjustments), a materially different semantic from
 * `MerchantStatement.grossVolume`'s own "this period's charges" framing
 * even though both are computed from the same underlying ledger
 * events. See this class's own `monthlyAmounts` field for Box 5a-5l,
 * and `thresholdApplied` for why the threshold that actually produced
 * `reportable` is recorded on the form itself rather than re-derived
 * from whatever the current config says later.
 */
export class MerchantTaxForm1099K {
  private constructor(
    public readonly id: string,
    public readonly merchantId: string,
    public readonly taxYear: number,
    public readonly currencyCode: string,
    public readonly grossAmount: Money,
    public readonly transactionCount: number,
    public readonly monthlyAmounts: Money[],
    public readonly thresholdApplied: Money,
    public readonly reportable: boolean,
    public readonly generatedAt: Date,
  ) {}

  static create(params: {
    id: string;
    merchantId: string;
    taxYear: number;
    currencyCode: string;
    grossAmount: Money;
    transactionCount: number;
    monthlyAmounts: Money[];
    thresholdApplied: Money;
  }): MerchantTaxForm1099K {
    return new MerchantTaxForm1099K(
      params.id,
      params.merchantId,
      params.taxYear,
      params.currencyCode,
      params.grossAmount,
      params.transactionCount,
      params.monthlyAmounts,
      params.thresholdApplied,
      !params.grossAmount.isLessThan(params.thresholdApplied),
      new Date(),
    );
  }

  static reconstitute(params: {
    id: string;
    merchantId: string;
    taxYear: number;
    currencyCode: string;
    grossAmount: Money;
    transactionCount: number;
    monthlyAmounts: Money[];
    thresholdApplied: Money;
    reportable: boolean;
    generatedAt: Date;
  }): MerchantTaxForm1099K {
    return new MerchantTaxForm1099K(
      params.id,
      params.merchantId,
      params.taxYear,
      params.currencyCode,
      params.grossAmount,
      params.transactionCount,
      params.monthlyAmounts,
      params.thresholdApplied,
      params.reportable,
      params.generatedAt,
    );
  }
}
