import { ReconciliationRun } from '../../domain/aggregates/reconciliation-run.aggregate';
import { PSPProvider } from '../../domain/aggregates/payment.aggregate';

/**
 * Reconciliation Port (Outbound)
 * Persistence contract for reconciliation run records.
 */
export abstract class ReconciliationPort {
  abstract save(run: ReconciliationRun): Promise<void>;

  /** Most recent runs across all providers, newest first. */
  abstract findRecent(limit?: number): Promise<ReconciliationRun[]>;

  /** Most recent runs for one provider, newest first. */
  abstract findByProvider(pspProvider: PSPProvider, limit?: number): Promise<ReconciliationRun[]>;
}
