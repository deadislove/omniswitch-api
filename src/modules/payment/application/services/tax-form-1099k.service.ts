import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { randomUUID as uuidv4 } from 'crypto';
import { MerchantStatementService } from './merchant-statement.service';
import { MerchantTaxFormPort } from '../../ports/outbound/merchant-tax-form.port';
import { MerchantTaxForm1099K } from '../../domain/aggregates/merchant-tax-form-1099k.aggregate';
import { Money } from '../../domain/value-objects/money.vo';
import { MerchantService } from '../../../merchant/merchant.service';

const TAX_FORM_SWEEP_BATCH_SIZE = 50;

/**
 * This is the real statutory dollar figure, not an arbitrary round
 * number this codebase picked — but it's gone through a multi-year
 * IRS phase-in that's genuinely worth re-checking against current
 * guidance for whatever tax year this gets used against: the American
 * Rescue Plan Act (2021) set the eventual threshold at $600 with no
 * transaction-count minimum (replacing the old $20,000/200-transaction
 * rule), but the IRS granted transition relief that phased it in over
 * several years — $20,000/200 transactions for 2023 (Notice 2023-74),
 * $5,000 for 2024 (Notice 2024-85), an anticipated $2,500 for 2025,
 * and the full $600 statutory threshold from 2026 onward. Configurable
 * via `IRS_1099K_THRESHOLD_USD` specifically so a deployment modeling
 * an earlier tax year doesn't have to edit code to use the real figure
 * for that year.
 */
const DEFAULT_1099K_THRESHOLD_USD = 600;

/**
 * 1099-K Tax Form Service
 * Packages each US merchant's annual settled volume into what a real
 * payment processor would need to report to the IRS once it crosses
 * the statutory threshold — see `MerchantTaxForm1099K`'s own docblock
 * for the explicit "computed, never actually filed" framing, and
 * `docs/technical/compliance-certification-roadmap.md`'s 1099-K
 * section for the full writeup.
 *
 * Deliberately reuses `MerchantStatementService.computeBreakdowns()`
 * rather than re-deriving ledger-walking logic — Box 1a's "gross
 * amount of reportable payment transactions" is the same real number
 * `MerchantStatement.grossVolume` already reconstructs from the
 * ledger (merchant credit + platform fee + BNPL provider fee, from
 * this merchant's own non-split charges), just for a full calendar
 * year instead of a statement period, with one real-world-accuracy
 * difference: Box 1a is **not** reduced by refunds/chargebacks at
 * all (the real IRS rule), so this never touches
 * `refundedAmount`/`chargebackAmount` the way a merchant statement's
 * own `netSettlement` does.
 *
 * One form per `(merchantId, taxYear)`, denominated in whichever
 * currency had this merchant's largest gross volume that year — a
 * real 1099-K is a single form, and this codebase has no real
 * historical FX-rate reconstruction to consolidate multiple
 * currencies into one figure for a past year, so a merchant with
 * genuine multi-currency activity gets the other currencies' volume
 * logged as an explicit, visible gap rather than silently dropped or
 * incorrectly summed across currencies.
 */
@Injectable()
export class TaxForm1099KService {
  private readonly logger = new Logger(TaxForm1099KService.name);
  private readonly thresholdUsd: number;

  constructor(
    private readonly merchantStatementService: MerchantStatementService,
    private readonly taxFormPort: MerchantTaxFormPort,
    private readonly merchantService: MerchantService,
    configService: ConfigService,
  ) {
    this.thresholdUsd = Number(configService.get('IRS_1099K_THRESHOLD_USD', DEFAULT_1099K_THRESHOLD_USD));
  }

  /**
   * `grossAmount` adds this merchant's own marketplace-split-sourced
   * *credits* (never debits — Box 1a is gross, unadjusted) on top of
   * `MerchantStatementService`'s own direct-charge `grossVolume` — a
   * connected merchant's split proceeds are real money a processor
   * would have to report for that payee, even though (same limitation
   * `StatementCurrencyBreakdown`'s own docblock already documents) a
   * split event gives no way to reconstruct a *pre-fee* gross for just
   * one party's share, so the split credit is added at face value
   * rather than grossed up further.
   */
  async computeForMerchant(merchantId: string, taxYear: number): Promise<MerchantTaxForm1099K | null> {
    const yearStart = new Date(Date.UTC(taxYear, 0, 1));
    const yearEnd = new Date(Date.UTC(taxYear + 1, 0, 1));

    const breakdowns = await this.merchantStatementService.computeBreakdowns(merchantId, yearStart, yearEnd);
    if (breakdowns.length === 0) {
      return null;
    }

    const grossWithSplits = (b: (typeof breakdowns)[number]) =>
      b.grossVolume.amountMinorUnits + (b.marketplaceSplitProceedsMinorUnits > 0n ? b.marketplaceSplitProceedsMinorUnits : 0n);

    const dominant = [...breakdowns].sort((a, b) => {
      const diff = grossWithSplits(b) - grossWithSplits(a);
      if (diff !== 0n) return diff > 0n ? 1 : -1;
      return a.currencyCode.localeCompare(b.currencyCode);
    })[0];

    if (breakdowns.length > 1) {
      const others = breakdowns.filter((b) => b.currencyCode !== dominant.currencyCode);
      this.logger.warn(
        `1099-K for merchant ${merchantId} tax year ${taxYear}: activity in ${breakdowns.length} currencies — ` +
          `reporting only ${dominant.currencyCode} (this codebase has no real historical FX reconstruction to consolidate them); ` +
          `excluded currencies: ${others.map((o) => `${o.currencyCode}=${grossWithSplits(o)}`).join(', ')}`,
      );
    }

    const currencyCode = dominant.currencyCode;
    const grossAmount = Money.fromMinorUnits(grossWithSplits(dominant), currencyCode);

    const monthlyAmounts: Money[] = [];
    for (let month = 0; month < 12; month++) {
      const monthStart = new Date(Date.UTC(taxYear, month, 1));
      const monthEnd = new Date(Date.UTC(taxYear, month + 1, 1));
      const monthBreakdowns = await this.merchantStatementService.computeBreakdowns(merchantId, monthStart, monthEnd);
      const monthBreakdown = monthBreakdowns.find((b) => b.currencyCode === currencyCode);
      monthlyAmounts.push(monthBreakdown ? Money.fromMinorUnits(grossWithSplits(monthBreakdown), currencyCode) : Money.zero(currencyCode));
    }

    // See this class's own docblock: the configured threshold is a plain
    // number of major units, applied as-is in whatever currency this
    // form happens to be in — no real USD/foreign-currency conversion,
    // a known simplification for a non-USD-denominated form.
    const thresholdApplied = Money.of(this.thresholdUsd, currencyCode);

    return MerchantTaxForm1099K.create({
      id: uuidv4(),
      merchantId,
      taxYear,
      currencyCode,
      grossAmount,
      transactionCount: dominant.chargeCount,
      monthlyAmounts,
      thresholdApplied,
    });
  }

  async generateForMerchant(merchantId: string, taxYear: number): Promise<MerchantTaxForm1099K | null> {
    const existing = await this.taxFormPort.findByMerchantAndYear(merchantId, taxYear);
    if (existing) {
      return existing;
    }

    const form = await this.computeForMerchant(merchantId, taxYear);
    if (!form) {
      return null;
    }
    await this.taxFormPort.save(form);
    return form;
  }

  /**
   * Runs at 3am on January 2nd — the day after the calendar year this
   * sweep evaluates has fully closed — for every merchant with
   * `country` set to `US` (an unknown/unset country is excluded
   * entirely rather than assumed non-US; see
   * `MerchantEntity.country`'s own docblock). Every evaluated merchant
   * gets a persisted row regardless of `reportable`'s outcome — unlike
   * `MerchantStatementService`'s own monthly sweep, which skips
   * merchants with zero activity, a 1099-K evaluation result (even "we
   * checked, they were under threshold") is itself the kind of
   * auditable compliance fact an operator would want on record for
   * every merchant, every year, since it's an annual check rather than
   * a chatty monthly one.
   */
  @Cron('0 3 2 1 *', { name: 'tax-form-1099k-sweep' })
  async runAnnualSweep(now: Date = new Date()): Promise<{ generated: number; skipped: number }> {
    const taxYear = now.getUTCFullYear() - 1;
    let generated = 0;
    let skipped = 0;
    let afterId: string | undefined;

    for (;;) {
      const batch = await this.merchantService.findActiveByCountryBatch('US', afterId, TAX_FORM_SWEEP_BATCH_SIZE);
      if (batch.length === 0) break;

      for (const merchant of batch) {
        try {
          const existing = await this.taxFormPort.findByMerchantAndYear(merchant.merchantId, taxYear);
          if (existing) {
            skipped++;
            continue;
          }
          const form = await this.computeForMerchant(merchant.merchantId, taxYear);
          if (!form) {
            skipped++;
            continue;
          }
          await this.taxFormPort.save(form);
          generated++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`1099-K sweep: failed to generate for merchant ${merchant.merchantId}: ${msg}`);
          skipped++;
        }
      }

      afterId = batch[batch.length - 1].id;
      if (batch.length < TAX_FORM_SWEEP_BATCH_SIZE) break;
    }

    if (generated > 0 || skipped > 0) {
      this.logger.log(`1099-K sweep for tax year ${taxYear}: ${generated} generated, ${skipped} skipped`);
    }
    return { generated, skipped };
  }
}
