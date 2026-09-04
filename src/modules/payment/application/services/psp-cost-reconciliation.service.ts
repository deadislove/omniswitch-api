import { Injectable, Logger } from '@nestjs/common';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { PspFeeScheduleService } from './psp-fee-schedule.service';
import { PaymentProcessorFactory } from '../../adapters/psp/payment-processor.factory';
import { PSPProvider } from '../../domain/aggregates/payment.aggregate';
import { PaymentStatus } from '../../domain/value-objects/payment-status.vo';

// Same list, same reasoning, as RiskTieringService's SETTLED_STATUSES — a
// real charge happened at the PSP (and so was really fee-bearing) for any
// of these, regardless of what happened to the payment afterward. Kept as
// its own copy rather than importing RiskTieringService's private
// constant: duplicating four enum values is cheaper than coupling two
// otherwise-unrelated services just to share a list.
const SETTLED_STATUSES: PaymentStatus[] = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
  PaymentStatus.DISPUTED,
];

export interface PspCostReconciliationReport {
  provider: PSPProvider;
  currency: string;
  since: Date;
  until: Date;
  chargesEvaluated: number;
  grossVolumeMinorUnits: string;
  estimatedFeeMinorUnits: string;
  actualInvoicedFeeMinorUnits: string;
  /** True when actualInvoicedFeeMinorUnits came from PSPAdapterPort.fetchFeeStatement() rather than an operator-supplied override. */
  actualFeeSource: 'PSP_STATEMENT' | 'MANUAL_OVERRIDE';
  deltaMinorUnits: string;
  /** null when estimatedFeeMinorUnits is 0 — a percentage of zero is undefined, not zero. */
  deltaPercent: number | null;
}

/**
 * Closes the specific gap future-directions.md's Fee model section flags:
 * the *estimated* PSP cost smart-routing uses to pick a cheaper provider
 * (PspFeeScheduleService, now configurable — see its own docblock) and
 * what a PSP *actually* invoices this platform are two disconnected
 * numbers. Both sides are now computed for real: the estimate from real
 * settled charges, the actual side from PSPAdapterPort.fetchFeeStatement()
 * — against mock-psp's `/statement` endpoints in this environment (a
 * real, deterministic simulated fee schedule with per-transaction
 * variance, not a flat match to the estimate — see mock-psp's own
 * comment), against whatever a real Stripe/Adyen deployment's own fee
 * reporting API returns in production. `actualInvoicedFeeMinorUnits` can
 * still be passed explicitly to override the fetched figure (e.g.
 * reconciling against a real downloaded PSP statement PDF/CSV instead of
 * the API) — the report records which source was actually used
 * (`actualFeeSource`) so a report can't be mistaken for the other kind.
 */
@Injectable()
export class PspCostReconciliationService {
  private readonly logger = new Logger(PspCostReconciliationService.name);

  constructor(
    private readonly paymentRepository: PaymentRepositoryPort,
    private readonly feeSchedule: PspFeeScheduleService,
    private readonly processorFactory: PaymentProcessorFactory,
  ) {}

  async computeReport(params: {
    provider: PSPProvider;
    currency: string;
    since: Date;
    until: Date;
    /** Overrides the fetched PSP statement figure when supplied — see this class's own docblock. */
    actualInvoicedFeeMinorUnits?: bigint;
  }): Promise<PspCostReconciliationReport> {
    const { provider, currency, since, until } = params;

    let actualInvoicedFeeMinorUnits: bigint;
    let actualFeeSource: 'PSP_STATEMENT' | 'MANUAL_OVERRIDE';
    if (params.actualInvoicedFeeMinorUnits !== undefined) {
      actualInvoicedFeeMinorUnits = params.actualInvoicedFeeMinorUnits;
      actualFeeSource = 'MANUAL_OVERRIDE';
    } else {
      const statement = await this.processorFactory.getAdapter(provider).fetchFeeStatement(since, until, currency);
      actualInvoicedFeeMinorUnits = statement.totalFeeMinorUnits;
      actualFeeSource = 'PSP_STATEMENT';
    }

    const payments = await this.paymentRepository.findByProviderAndDateRange(provider, since, until);
    const settled = payments.filter(
      (p) => SETTLED_STATUSES.includes(p.status) && p.amount.currency.code === currency.toUpperCase(),
    );

    let grossVolumeMinorUnits = 0n;
    for (const payment of settled) {
      grossVolumeMinorUnits += payment.amount.amountMinorUnits;
    }

    const schedule = this.feeSchedule.getSchedule(provider);
    // Plain Number arithmetic for the percentage leg, not Money/bigint —
    // this is an *estimate* (feePercentage is a configured approximation
    // of a real, per-card-network interchange schedule this codebase
    // doesn't model), so the sub-cent precision Money's bigint math exists
    // to guarantee for real ledger entries isn't the point here.
    const percentageFeeMinorUnits = Math.round((Number(grossVolumeMinorUnits) * schedule.feePercentage) / 100);
    const fixedFeeMinorUnits = schedule.fixedFeeMinorUnits * settled.length;
    const estimatedFeeMinorUnits = BigInt(percentageFeeMinorUnits) + BigInt(fixedFeeMinorUnits);

    const deltaMinorUnits = actualInvoicedFeeMinorUnits - estimatedFeeMinorUnits;
    const deltaPercent =
      estimatedFeeMinorUnits === 0n ? null : (Number(deltaMinorUnits) / Number(estimatedFeeMinorUnits)) * 100;

    this.logger.log(
      `PSP cost reconciliation for ${provider} [${since.toISOString()} - ${until.toISOString()}]: ` +
        `${settled.length} charges, estimated ${estimatedFeeMinorUnits} ${currency} minor units vs. ` +
        `actual invoiced ${actualInvoicedFeeMinorUnits} (source: ${actualFeeSource}) — delta ${deltaMinorUnits} ` +
        `(${deltaPercent?.toFixed(2) ?? 'n/a'}%)`,
    );

    return {
      provider,
      currency: currency.toUpperCase(),
      since,
      until,
      chargesEvaluated: settled.length,
      grossVolumeMinorUnits: grossVolumeMinorUnits.toString(),
      estimatedFeeMinorUnits: estimatedFeeMinorUnits.toString(),
      actualInvoicedFeeMinorUnits: actualInvoicedFeeMinorUnits.toString(),
      actualFeeSource,
      deltaMinorUnits: deltaMinorUnits.toString(),
      deltaPercent,
    };
  }
}
