import 'dotenv/config';
import { AppDataSource } from '../database/data-source';

/**
 * Archiving job.
 *
 * Standalone script, not a `@Cron()` method on a running service —
 * deliberately: `@Cron()` runs once per pod, which at `k8s/hpa.yaml`'s
 * `maxReplicas: 20` would mean up to 20 concurrent archiving runs racing
 * each other. This script is instead the target of a k8s `CronJob`
 * (`k8s/archiving-cronjob.yaml`), which only ever spins up one pod per
 * scheduled run — the duplication problem doesn't exist by construction.
 * Bootstraps a plain `DataSource` the same way `seed-admin.ts` does
 * (outside the Nest DI container — this job needs raw SQL access, not
 * the app's HTTP-serving dependency graph).
 *
 * Eligibility — a payment is archived when ALL of:
 *   - `created_at` is older than `ARCHIVE_THRESHOLD_DAYS` (default 180)
 *   - `status` is terminal (SUCCEEDED, FAILED, CANCELLED, REFUNDED,
 *     PARTIALLY_REFUNDED) — excludes anything still in flight or
 *     actively disputed (`DISPUTED` is its own status, deliberately not
 *     terminal here)
 *   - no `disputes` row referencing it is still open (NEEDS_RESPONSE or
 *     UNDER_REVIEW)
 *   - no `reconciliation_runs.mismatches` entry references it — a flagged
 *     mismatch means this payment's settlement hasn't been confirmed
 *     against the PSP's own record yet, so it isn't "reconciled" in the
 *     sense Option 3's policy requires
 *   - `legal_hold` is false — see LegalHoldService/admin/payments/:id/
 *     legal-hold (Phase 3 follow-up #5). Overrides all of the above:
 *     a held payment is excluded regardless of age, status, or dispute
 *     state, until the hold is explicitly released.
 * A `ledger_outbox` entry is archived independently, on its own
 * `created_at`/`ARCHIVE_THRESHOLD_DAYS`, once `status = 'PUBLISHED'` —
 * `FAILED` entries stay live since they're still actionable via the
 * outbox dead-letter admin recovery flow.
 *
 * This is a POC-scoped eligibility check, not a certified compliance
 * implementation — see docs/compliance/data-retention.md for what a
 * real deployment still needs to review before relying on this.
 */

const ARCHIVE_THRESHOLD_DAYS = Number(process.env.ARCHIVE_THRESHOLD_DAYS) || 180;

const TERMINAL_PAYMENT_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'];
const OPEN_DISPUTE_STATUSES = ['NEEDS_RESPONSE', 'UNDER_REVIEW'];

interface RunSummary {
  archiveThresholdDays: number;
  paymentsEligible: number;
  paymentsArchived: number;
  ledgerOutboxEligible: number;
  ledgerOutboxArchived: number;
  durationMs: number;
  status: 'success' | 'failed';
  error?: string;
}

/**
 * Moves every eligible payment (see the eligibility list above) from
 * `payments` into `archive.payments`, in one transaction per call.
 *
 * Returns `eligible` (how many rows matched the eligibility criteria at
 * the start of this call) and `archived` (how many were actually
 * inserted into `archive.payments` — normally equal to `eligible`, but
 * can be lower if a concurrent insert already archived a row between
 * the count and the insert, since `ON CONFLICT ("id") DO NOTHING` skips
 * it rather than erroring). The caller (`main()`) logs both so a
 * mismatch between them is visible in the job's own run summary.
 */
export async function archivePayments(): Promise<{ eligible: number; archived: number }> {
  const runner = AppDataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const [{ count: eligibleCount }] = await runner.query(
      `SELECT count(*) FROM "payments" p
       WHERE p.created_at < now() - ($1 || ' days')::interval
         AND p.status = ANY($2)
         AND NOT p.legal_hold
         AND NOT EXISTS (SELECT 1 FROM "disputes" d WHERE d.payment_id = p.id::varchar AND d.status = ANY($3))
         AND NOT EXISTS (
           SELECT 1 FROM "reconciliation_runs" r, jsonb_array_elements(r.mismatches) m
           WHERE m->>'paymentId' = p.id::varchar
         )`,
      [ARCHIVE_THRESHOLD_DAYS, TERMINAL_PAYMENT_STATUSES, OPEN_DISPUTE_STATUSES],
    );

    const inserted = await runner.query(
      `INSERT INTO "archive"."payments" (
         "id", "merchant_id", "customer_id", "order_id", "amount_minor_units",
         "currency_code", "currency_minor_units", "status", "idempotency_key",
         "psp_provider", "psp_transaction_id", "psp_raw_response", "risk_score",
         "three_ds_result", "refunds", "captures", "failure_reason", "failure_code",
         "description", "statement_descriptor", "payment_metadata", "bin_info",
         "fx_snapshot", "settlement_conversion", "splits", "created_at", "updated_at"
       )
       SELECT
         p."id", p."merchant_id", p."customer_id", p."order_id", p."amount_minor_units",
         p."currency_code", p."currency_minor_units", p."status", p."idempotency_key",
         p."psp_provider", p."psp_transaction_id", p."psp_raw_response", p."risk_score",
         p."three_ds_result", p."refunds", p."captures", p."failure_reason", p."failure_code",
         p."description", p."statement_descriptor", p."payment_metadata", p."bin_info",
         p."fx_snapshot", p."settlement_conversion", p."splits", p."created_at", p."updated_at"
       FROM "payments" p
       WHERE p.created_at < now() - ($1 || ' days')::interval
         AND p.status = ANY($2)
         AND NOT p.legal_hold
         AND NOT EXISTS (SELECT 1 FROM "disputes" d WHERE d.payment_id = p.id::varchar AND d.status = ANY($3))
         AND NOT EXISTS (
           SELECT 1 FROM "reconciliation_runs" r, jsonb_array_elements(r.mismatches) m
           WHERE m->>'paymentId' = p.id::varchar
         )
       ON CONFLICT ("id") DO NOTHING
       RETURNING "id"`,
      [ARCHIVE_THRESHOLD_DAYS, TERMINAL_PAYMENT_STATUSES, OPEN_DISPUTE_STATUSES],
    );

    if (inserted.length > 0) {
      const ids = inserted.map((row: { id: string }) => row.id);
      await runner.query(`DELETE FROM "payments" WHERE "id" = ANY($1)`, [ids]);
    }

    await runner.commitTransaction();
    return { eligible: Number(eligibleCount), archived: inserted.length };
  } catch (err) {
    await runner.rollbackTransaction();
    throw err;
  } finally {
    await runner.release();
  }
}

/**
 * Same shape as `archivePayments()`, for `ledger_outbox` entries — moves
 * every `PUBLISHED` entry older than `ARCHIVE_THRESHOLD_DAYS` into
 * `archive.ledger_outbox`. Returns `eligible`/`archived` with the same
 * meaning as `archivePayments()`.
 */
export async function archiveLedgerOutbox(): Promise<{ eligible: number; archived: number }> {
  const runner = AppDataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const [{ count: eligibleCount }] = await runner.query(
      `SELECT count(*) FROM "ledger_outbox"
       WHERE created_at < now() - ($1 || ' days')::interval AND status = 'PUBLISHED'`,
      [ARCHIVE_THRESHOLD_DAYS],
    );

    const inserted = await runner.query(
      `INSERT INTO "archive"."ledger_outbox" (
         "id", "payment_id", "event_type", "entries", "status",
         "retry_count", "last_error", "processed_at", "created_at"
       )
       SELECT
         "id", "payment_id", "event_type", "entries", "status",
         "retry_count", "last_error", "processed_at", "created_at"
       FROM "ledger_outbox"
       WHERE created_at < now() - ($1 || ' days')::interval AND status = 'PUBLISHED'
       ON CONFLICT ("id") DO NOTHING
       RETURNING "id"`,
      [ARCHIVE_THRESHOLD_DAYS],
    );

    if (inserted.length > 0) {
      const ids = inserted.map((row: { id: string }) => row.id);
      await runner.query(`DELETE FROM "ledger_outbox" WHERE "id" = ANY($1)`, [ids]);
    }

    await runner.commitTransaction();
    return { eligible: Number(eligibleCount), archived: inserted.length };
  } catch (err) {
    await runner.rollbackTransaction();
    throw err;
  } finally {
    await runner.release();
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  await AppDataSource.initialize();
  try {
    const payments = await archivePayments();
    const ledgerOutbox = await archiveLedgerOutbox();

    const summary: RunSummary = {
      archiveThresholdDays: ARCHIVE_THRESHOLD_DAYS,
      paymentsEligible: payments.eligible,
      paymentsArchived: payments.archived,
      ledgerOutboxEligible: ledgerOutbox.eligible,
      ledgerOutboxArchived: ledgerOutbox.archived,
      durationMs: Date.now() - startedAt,
      status: 'success',
    };
    // Structured, single-line JSON — greppable in CronJob pod logs
    // without a Pushgateway. A short-lived CLI process like this one
    // exits before a normal prom-client pull-based scrape could ever
    // reach it, so structured stdout is the observability mechanism
    // here instead of a /metrics endpoint.
    console.log(JSON.stringify({ job: 'archiving', ...summary }));
  } catch (err) {
    const summary: Partial<RunSummary> = {
      archiveThresholdDays: ARCHIVE_THRESHOLD_DAYS,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
    console.error(JSON.stringify({ job: 'archiving', ...summary }));
    throw err;
  } finally {
    await AppDataSource.destroy();
  }
}

// Guarded so importing `archivePayments`/`archiveLedgerOutbox` from a
// test file doesn't also trigger a real run against whatever DB the
// test process happens to be configured against.
if (require.main === module) {
  main().catch(() => {
    process.exit(1);
  });
}
