import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID as uuidv4 } from 'crypto';
import { LedgerOutboxPort } from '../../ports/outbound/ledger-outbox.port';
import { DisputePort } from '../../ports/outbound/dispute.port';
import { MerchantStatementPort } from '../../ports/outbound/merchant-statement.port';
import { MerchantStatement, StatementCurrencyBreakdown } from '../../domain/aggregates/merchant-statement.aggregate';
import { Money } from '../../domain/value-objects/money.vo';
import { MerchantService } from '../../../merchant/merchant.service';

const STATEMENT_SWEEP_BATCH_SIZE = 50;

interface MutableBreakdown {
  currencyCode: string;
  chargeCount: number;
  grossVolumeMinorUnits: bigint;
  platformFeeMinorUnits: bigint;
  providerFeeMinorUnits: bigint;
  refundedAmountMinorUnits: bigint;
  chargebackCount: number;
  chargebackAmountMinorUnits: bigint;
  marketplaceSplitProceedsMinorUnits: bigint;
  netSettlementMinorUnits: bigint;
}

const CHARGE_EVENT_TYPES = new Set(['PAYMENT_CHARGED', 'BNPL_CAPTURED']);
const REFUND_EVENT_TYPES = new Set(['PAYMENT_REFUNDED', 'BNPL_REFUNDED']);

/**
 * Merchant Statement Service
 * Packages a merchant's ledger activity for a period into the periodic,
 * human-readable document a real acquirer/PSP gives each merchant to
 * reconcile against — volume, fees, chargebacks, net settlement — closer
 * to reporting/aggregation work than new business logic, since every
 * number here already exists somewhere in the ledger (see
 * `docs/business-domain/ledger-accounting.md`'s statement section for
 * the full writeup).
 *
 * Same dual on-demand + scheduled shape as
 * `ReconciliationService`/`PayoutService`: `generateForMerchant()` is
 * both what the monthly `@Cron` sweep calls per merchant and what
 * `POST /admin/merchants/:id/statements/generate` calls directly.
 *
 * Idempotent on `(merchantId, periodStart, periodEnd)` rather than
 * overwriting — a closed period's own ledger history doesn't change
 * after the fact (a chargeback is attributed to the period it was
 * *received* in, not resolved in, same convention
 * `RiskTieringService`'s trailing lost-dispute rate already uses — see
 * `DisputePort.findByMerchantStatusInRange()`'s own docblock), so
 * regenerating the same period is expected to produce the exact same
 * numbers, and a statement a merchant has already looked at shouldn't
 * silently change under them.
 */
@Injectable()
export class MerchantStatementService {
  private readonly logger = new Logger(MerchantStatementService.name);

  constructor(
    private readonly ledgerOutbox: LedgerOutboxPort,
    private readonly disputePort: DisputePort,
    private readonly statementPort: MerchantStatementPort,
    private readonly merchantService: MerchantService,
  ) {}

  /**
   * Walks every ledger-outbox event created in `[periodStart, periodEnd)`
   * once and buckets this merchant's own `MERCHANT`-type entries by
   * currency — see `StatementCurrencyBreakdown`'s own docblock for why
   * `grossVolume`/`platformFee`/`providerFee` only come from this
   * merchant's *direct* (non-split) charges, while
   * `netSettlementMinorUnits` is the literal, always-reconciling sum of
   * every `MERCHANT` entry regardless of event shape.
   */
  async computeBreakdowns(
    merchantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<StatementCurrencyBreakdown[]> {
    const events = await this.ledgerOutbox.findCreatedBetween(periodStart, periodEnd);
    const byCurrency = new Map<string, MutableBreakdown>();

    const getBreakdown = (currencyCode: string): MutableBreakdown => {
      let b = byCurrency.get(currencyCode);
      if (!b) {
        b = {
          currencyCode,
          chargeCount: 0,
          grossVolumeMinorUnits: 0n,
          platformFeeMinorUnits: 0n,
          providerFeeMinorUnits: 0n,
          refundedAmountMinorUnits: 0n,
          chargebackCount: 0,
          chargebackAmountMinorUnits: 0n,
          marketplaceSplitProceedsMinorUnits: 0n,
          netSettlementMinorUnits: 0n,
        };
        byCurrency.set(currencyCode, b);
      }
      return b;
    };

    for (const event of events) {
      const merchantEntries = event.entries.filter((e) => e.accountType === 'MERCHANT' && e.accountId === merchantId);
      if (merchantEntries.length === 0) continue;

      // Net settlement: every MERCHANT entry for this merchant counts,
      // regardless of event type or whether it was a split — this is the
      // one figure that always reconciles against the real ledger by
      // construction (see this class's own docblock).
      for (const entry of merchantEntries) {
        const b = getBreakdown(entry.amount.currency.code);
        const sign = entry.entryType === 'CREDIT' ? 1n : -1n;
        b.netSettlementMinorUnits += sign * entry.amount.amountMinorUnits;
      }

      const totalMerchantEntriesInEvent = event.entries.filter((e) => e.accountType === 'MERCHANT').length;
      const isSplit = totalMerchantEntriesInEvent > 1;

      if (CHARGE_EVENT_TYPES.has(event.eventType)) {
        if (!isSplit) {
          const creditEntry = merchantEntries.find((e) => e.entryType === 'CREDIT');
          if (creditEntry) {
            const feeEntry = event.entries.find((e) => e.accountType === 'FEE');
            const providerFeeEntry = event.entries.find((e) => e.accountType === 'BNPL_PROVIDER_FEE');
            const feeAmount = feeEntry?.amount.amountMinorUnits ?? 0n;
            const providerFeeAmount = providerFeeEntry?.amount.amountMinorUnits ?? 0n;

            const b = getBreakdown(creditEntry.amount.currency.code);
            b.chargeCount += 1;
            b.grossVolumeMinorUnits += creditEntry.amount.amountMinorUnits + feeAmount + providerFeeAmount;
            b.platformFeeMinorUnits += feeAmount;
            b.providerFeeMinorUnits += providerFeeAmount;
          }
        } else {
          // A split charge shares one event across multiple merchants —
          // no way to attribute a single party's share of the pre-fee
          // gross from the entries alone, so this merchant's own
          // credit/debit is tracked separately rather than folded into
          // grossVolume/platformFee (see this breakdown's own docblock).
          for (const entry of merchantEntries) {
            const b = getBreakdown(entry.amount.currency.code);
            const sign = entry.entryType === 'CREDIT' ? 1n : -1n;
            b.marketplaceSplitProceedsMinorUnits += sign * entry.amount.amountMinorUnits;
          }
        }
      } else if (REFUND_EVENT_TYPES.has(event.eventType)) {
        // Covers both an ordinary merchant-initiated refund and a lost
        // dispute's reversal — DisputeService.resolveDispute() books a
        // lost dispute through this exact same createRefundEntries()
        // path (see ledger-accounting.md), so there's no separate
        // "chargeback reversal" ledger shape to distinguish here. The
        // chargeback *count* (not amount — already included below)
        // comes from DisputePort separately.
        for (const entry of merchantEntries) {
          if (entry.entryType === 'DEBIT') {
            const b = getBreakdown(entry.amount.currency.code);
            b.refundedAmountMinorUnits += entry.amount.amountMinorUnits;
          }
        }
      }
    }

    const lostDisputes = await this.disputePort.findByMerchantStatusInRange(merchantId, 'LOST', periodStart, periodEnd);
    for (const dispute of lostDisputes) {
      const b = getBreakdown(dispute.amount.currency.code);
      b.chargebackCount += 1;
      b.chargebackAmountMinorUnits += dispute.amount.amountMinorUnits;
    }

    return Array.from(byCurrency.values()).map((b) => ({
      currencyCode: b.currencyCode,
      chargeCount: b.chargeCount,
      grossVolume: Money.fromMinorUnits(b.grossVolumeMinorUnits, b.currencyCode),
      platformFee: Money.fromMinorUnits(b.platformFeeMinorUnits, b.currencyCode),
      providerFee: Money.fromMinorUnits(b.providerFeeMinorUnits, b.currencyCode),
      refundedAmount: Money.fromMinorUnits(b.refundedAmountMinorUnits, b.currencyCode),
      chargebackCount: b.chargebackCount,
      chargebackAmount: Money.fromMinorUnits(b.chargebackAmountMinorUnits, b.currencyCode),
      marketplaceSplitProceedsMinorUnits: b.marketplaceSplitProceedsMinorUnits,
      netSettlementMinorUnits: b.netSettlementMinorUnits,
    }));
  }

  async generateForMerchant(merchantId: string, periodStart: Date, periodEnd: Date): Promise<MerchantStatement> {
    const existing = await this.statementPort.findByMerchantAndPeriod(merchantId, periodStart, periodEnd);
    if (existing) {
      return existing;
    }

    const breakdowns = await this.computeBreakdowns(merchantId, periodStart, periodEnd);
    const statement = MerchantStatement.create({
      id: uuidv4(),
      merchantId,
      periodStart,
      periodEnd,
      breakdowns,
    });
    await this.statementPort.save(statement);
    return statement;
  }

  /**
   * Runs at noon on the 1st of each month, generating last calendar
   * month's statement for every active merchant — noon rather than
   * midnight to land clear of the midnight-clustered reserve-release
   * sweeps (`PayoutService`/`ReserveService`). Merchants with no ledger
   * activity at all in the period are skipped entirely (no empty
   * statement row) — an operator explicitly generating one on demand via
   * `POST /admin/merchants/:id/statements/generate` still gets one
   * either way, since that's a deliberate request rather than a
   * blanket sweep.
   */
  @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_NOON, { name: 'merchant-statement-sweep' })
  async runMonthlySweep(now: Date = new Date()): Promise<{ generated: number; skipped: number }> {
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    let generated = 0;
    let skipped = 0;
    let afterId: string | undefined;

    for (;;) {
      const batch = await this.merchantService.findActiveBatch(afterId, STATEMENT_SWEEP_BATCH_SIZE);
      if (batch.length === 0) break;

      for (const merchant of batch) {
        try {
          const breakdowns = await this.computeBreakdowns(merchant.merchantId, periodStart, periodEnd);
          if (breakdowns.length === 0) {
            skipped++;
            continue;
          }
          const existing = await this.statementPort.findByMerchantAndPeriod(
            merchant.merchantId,
            periodStart,
            periodEnd,
          );
          if (existing) {
            skipped++;
            continue;
          }
          const statement = MerchantStatement.create({
            id: uuidv4(),
            merchantId: merchant.merchantId,
            periodStart,
            periodEnd,
            breakdowns,
          });
          await this.statementPort.save(statement);
          generated++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`Statement sweep: failed to generate for merchant ${merchant.merchantId}: ${msg}`);
          skipped++;
        }
      }

      afterId = batch[batch.length - 1].id;
      if (batch.length < STATEMENT_SWEEP_BATCH_SIZE) break;
    }

    if (generated > 0 || skipped > 0) {
      this.logger.log(
        `Statement sweep for [${periodStart.toISOString()} - ${periodEnd.toISOString()}): ${generated} generated, ${skipped} skipped`,
      );
    }
    return { generated, skipped };
  }
}
