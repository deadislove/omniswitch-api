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
 * Five mismatch shapes are checked, beyond just "does the amount match":
 * - MISSING_AT_PSP: we booked a charge; the PSP has no matching record.
 *   The more dangerous direction — money we think we collected but didn't.
 * - AMOUNT_MISMATCH: both sides agree a transaction happened, in the same
 *   currency, but not on how much.
 * - CURRENCY_MISMATCH: both sides agree a transaction happened, but the
 *   settled currency differs from what we charged — kept distinct from
 *   AMOUNT_MISMATCH because a currency difference could be a real bug or
 *   legitimate PSP-side conversion (DCC, cross-border settlement); lumping
 *   it into AMOUNT_MISMATCH would make both look equally urgent when they
 *   aren't.
 * - UNKNOWN_AT_PSP: the PSP settled something we have no record of at all
 *   — could mean a missed webhook, or something that bypassed this system
 *   entirely.
 * - COMPARISON_ERROR: this one payment's comparison threw unexpectedly —
 *   its actual match status is left unconfirmed either way.
 *
 * Every payment is judged independently — one payment producing an
 * unexpected error doesn't abort the rest of the run (see the try/catch
 * inside the per-payment loop below); the same isolation runScheduled()
 * already applies per-provider.
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

    // Grouped rather than a 1:1 Map — a single authorization captured in multiple
    // partial captures (PaymentAggregate.recordCapture) produces multiple
    // PSP settlement transactions that all share the original
    // pspTransactionId. Naively keying a Map by id would silently keep only
    // the last one and compare against a fraction of what was actually
    // settled.
    //
    // Currency is checked explicitly before summing rather than relying on
    // Money.add()'s own currency-mismatch throw: two settlement records
    // sharing one pspTransactionId but reporting different currencies is an
    // edge case a real PSP could in principle produce, and letting it throw
    // here would abort this entire provider's run over one transaction
    // instead of being recorded as a single mismatch. Currency-inconsistent
    // ids are pulled out of the totals map entirely and handled explicitly
    // below.
    const pspTotalsByTxId = new Map<string, Money>();
    const currencyInconsistentTxIds = new Set<string>();
    for (const tx of pspTransactions) {
      if (currencyInconsistentTxIds.has(tx.pspTransactionId)) continue;
      const running = pspTotalsByTxId.get(tx.pspTransactionId);
      if (!running) {
        pspTotalsByTxId.set(tx.pspTransactionId, tx.amount);
        continue;
      }
      if (running.currency.code !== tx.amount.currency.code) {
        currencyInconsistentTxIds.add(tx.pspTransactionId);
        pspTotalsByTxId.delete(tx.pspTransactionId);
        continue;
      }
      pspTotalsByTxId.set(tx.pspTransactionId, running.add(tx.amount));
    }
    const matchedPspTxIds = new Set<string>();
    const mismatches: ReconciliationMismatch[] = [];

    for (const payment of ourPayments) {
      if (!payment.pspTransactionId) {
        // Shouldn't happen for the charged statuses this query returns, but
        // defensive rather than crashing the whole run over one bad record.
        continue;
      }
      // Each payment is judged independently — an unexpected error here
      // (not just the currency cases handled explicitly below) shouldn't
      // abort every other payment's comparison in this run.
      try {
        if (currencyInconsistentTxIds.has(payment.pspTransactionId)) {
          matchedPspTxIds.add(payment.pspTransactionId);
          mismatches.push({
            type: 'CURRENCY_MISMATCH',
            paymentId: payment.id,
            pspTransactionId: payment.pspTransactionId,
            expectedAmount: payment.amount,
            description: `Payment ${payment.id}: ${pspProvider}'s settlement records for pspTransactionId ${payment.pspTransactionId} report inconsistent currencies across settlement records (e.g. partial captures) and could not be summed — needs manual review.`,
          });
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

        if (pspTotal.currency.code !== payment.amount.currency.code) {
          // Distinct from AMOUNT_MISMATCH on purpose: a settled currency
          // differing from the charge currency could be a real bug, or
          // legitimate PSP-side conversion (DCC, cross-border settlement)
          // — it needs a human to look, but not with the same urgency as a
          // same-currency amount discrepancy, which is unambiguously wrong.
          mismatches.push({
            type: 'CURRENCY_MISMATCH',
            paymentId: payment.id,
            pspTransactionId: payment.pspTransactionId,
            expectedAmount: payment.amount,
            actualAmount: pspTotal,
            description: `Payment ${payment.id}: our ledger charged ${payment.amount.toString()}, but ${pspProvider} settled ${pspTotal.toString()} — a currency mismatch rather than a same-currency amount discrepancy. Review whether this is expected PSP-side currency conversion.`,
          });
          continue;
        }

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
      } catch (err: unknown) {
        // Should be unreachable given the explicit currency checks above,
        // but this is the safety net Phase 1 of the remediation plan asked
        // for: one payment's comparison failing unexpectedly must not fail
        // the whole provider's hourly run, the way it used to when this
        // loop had no per-payment isolation at all.
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Reconciliation comparison failed for payment ${payment.id} (${pspProvider}): ${msg}`);
        mismatches.push({
          type: 'COMPARISON_ERROR',
          paymentId: payment.id,
          pspTransactionId: payment.pspTransactionId,
          expectedAmount: payment.amount,
          description: `Payment ${payment.id}: comparison against ${pspProvider}'s settlement records failed unexpectedly (${msg}) — match status unknown, needs manual review.`,
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
