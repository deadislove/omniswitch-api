import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID as uuidv4 } from 'crypto';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { ReconciliationPort } from '../../ports/outbound/reconciliation.port';
import { PaymentProcessorFactory } from '../../adapters/psp/payment-processor.factory';
import { PSPProvider } from '../../domain/aggregates/payment.aggregate';
import { ReconciliationRun, ReconciliationMismatch } from '../../domain/aggregates/reconciliation-run.aggregate';
import { Money } from '../../domain/value-objects/money.vo';

const RECONCILED_PROVIDERS: PSPProvider[] = ['STRIPE', 'ADYEN'];
const WINDOW_MS = 60 * 60 * 1000; // 1 hour — matches the @Cron schedule below

/**
 * Reconciliation Service
 * Compares this system's ledger against each PSP's own settlement report —
 * an independent source of truth, external to this codebase — and flags
 * anything that doesn't match. See ReconciliationRun's docblock for why
 * this exists: it's the safety net for ledger/outbox bugs that unit and
 * e2e tests structurally can't catch (both this system's tests and its
 * ledger logic would have to be wrong the same way to miss one).
 *
 * Three mismatch shapes are checked, not just "does the amount match":
 * - MISSING_AT_PSP: we booked a charge; the PSP has no matching record.
 *   The more dangerous direction — money we think we collected but didn't.
 * - AMOUNT_MISMATCH: both sides agree a transaction happened, but not on
 *   how much.
 * - UNKNOWN_AT_PSP: the PSP settled something we have no record of at all
 *   — could mean a missed webhook, or something that bypassed this system
 *   entirely.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly paymentRepository: PaymentRepositoryPort,
    private readonly reconciliationRepo: ReconciliationPort,
    private readonly processorFactory: PaymentProcessorFactory,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'reconciliation' })
  async runScheduled(): Promise<void> {
    const until = new Date();
    const since = new Date(until.getTime() - WINDOW_MS);
    for (const provider of RECONCILED_PROVIDERS) {
      try {
        await this.reconcile(provider, since, until);
      } catch (err: unknown) {
        // One provider's PSP being unreachable shouldn't stop the other
        // from being checked.
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Reconciliation run for ${provider} failed to complete: ${msg}`);
      }
    }
  }

  async reconcile(pspProvider: PSPProvider, since: Date, until: Date): Promise<ReconciliationRun> {
    const [ourPayments, pspTransactions] = await Promise.all([
      this.paymentRepository.findByProviderAndDateRange(pspProvider, since, until),
      this.processorFactory.getAdapter(pspProvider).fetchSettlementTransactions(since, until),
    ]);

    // Grouped, not a 1:1 Map — a single authorization captured in multiple
    // partial captures (PaymentAggregate.recordCapture) produces multiple
    // PSP settlement transactions that all share the original
    // pspTransactionId. Naively keying a Map by id would silently keep only
    // the last one and compare against a fraction of what was actually
    // settled.
    const pspTotalsByTxId = new Map<string, Money>();
    for (const tx of pspTransactions) {
      const running = pspTotalsByTxId.get(tx.pspTransactionId);
      pspTotalsByTxId.set(tx.pspTransactionId, running ? running.add(tx.amount) : tx.amount);
    }
    const matchedPspTxIds = new Set<string>();
    const mismatches: ReconciliationMismatch[] = [];

    for (const payment of ourPayments) {
      if (!payment.pspTransactionId) {
        // Shouldn't happen for the charged statuses this query returns, but
        // defensive rather than crashing the whole run over one bad record.
        continue;
      }
      const pspTotal = pspTotalsByTxId.get(payment.pspTransactionId);
      if (!pspTotal) {
        mismatches.push({
          type: 'MISSING_AT_PSP',
          paymentId: payment.id,
          pspTransactionId: payment.pspTransactionId,
          expectedAmount: payment.amount,
          description: `Payment ${payment.id} is ${payment.status} in our ledger (pspTransactionId ${payment.pspTransactionId}), but ${pspProvider} has no matching settlement record in this window.`,
        });
        continue;
      }
      matchedPspTxIds.add(payment.pspTransactionId);
      if (!pspTotal.equals(payment.amount)) {
        mismatches.push({
          type: 'AMOUNT_MISMATCH',
          paymentId: payment.id,
          pspTransactionId: payment.pspTransactionId,
          expectedAmount: payment.amount,
          actualAmount: pspTotal,
          description: `Payment ${payment.id}: our ledger says ${payment.amount.toString()}, ${pspProvider} settled ${pspTotal.toString()} (summed across ${pspTransactions.filter((t) => t.pspTransactionId === payment.pspTransactionId).length} settlement record(s)).`,
        });
      }
    }

    for (const pspTx of pspTransactions) {
      if (!matchedPspTxIds.has(pspTx.pspTransactionId)) {
        mismatches.push({
          type: 'UNKNOWN_AT_PSP',
          pspTransactionId: pspTx.pspTransactionId,
          actualAmount: pspTx.amount,
          description: `${pspProvider} settled transaction ${pspTx.pspTransactionId} for ${pspTx.amount.toString()}, but we have no matching payment record.`,
        });
      }
    }

    const run = ReconciliationRun.create({
      id: uuidv4(),
      pspProvider,
      windowStart: since,
      windowEnd: until,
      transactionsChecked: ourPayments.length + pspTransactions.length,
      mismatches,
    });

    await this.reconciliationRepo.save(run);

    if (mismatches.length > 0) {
      // In production: page on-call / finance, emit a metric an alert is
      // wired to — same posture as LedgerOutboxRelayService.detectStaleEvents().
      this.logger.error(
        `Reconciliation run ${run.id} for ${pspProvider} [${since.toISOString()} - ${until.toISOString()}] found ${mismatches.length} mismatch(es).`,
      );
      for (const m of mismatches) {
        this.logger.error(`  [${m.type}] ${m.description}`);
      }
    } else {
      this.logger.log(
        `Reconciliation run ${run.id} for ${pspProvider}: clean (${ourPayments.length} of our payments, ${pspTransactions.length} PSP settlement transactions checked).`,
      );
    }

    return run;
  }
}
