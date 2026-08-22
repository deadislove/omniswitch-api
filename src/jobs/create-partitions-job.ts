import 'dotenv/config';
import { AppDataSource } from '../database/data-source';

/**
 * Partition-maintenance job (Phase 3 follow-up #1 — see
 * docs/spec/future/database-scaling.md Option 2, and the "does not
 * itself set up recurring maintenance" note in Stage 1's own migration
 * docblock: `1787325352938-CreatePartitionedPaymentsAndLedgerOutbox.ts`).
 *
 * That migration created partitions for a fixed window relative to
 * *when it ran* (6 months back, 2 forward) — correct at the time, but
 * nothing keeps extending that window as real time moves past it.
 * Without this job, once "now" gets within `PARTITION_MAINTENANCE_MONTHS_AHEAD`
 * of the last pre-created partition, new rows start silently landing in
 * the `DEFAULT` partition instead of a real monthly one — no error, no
 * rejection, just quietly losing the partitioning benefit for those
 * rows (see Option 2's query-audit reasoning for why that matters:
 * `DEFAULT` isn't scoped the way a monthly partition is).
 *
 * Same standalone-script, k8s-CronJob-driven shape as
 * `run-archiving-job.ts`/`run-deletion-job.ts` — see that file's
 * docblock for why this isn't a `@Cron()` method. This one specifically
 * must not run from inside a pod belonging to the main `omniswitch-api`
 * Deployment (`kubectl exec`-ing into one and running `npm run` there):
 * that pod's job is serving traffic, not hosting ad hoc maintenance
 * scripts, and it can be rescaled/recycled by the HPA or a rolling
 * update mid-operation. `k8s/partition-maintenance-cronjob.yaml` gives
 * this its own dedicated, disposable pod per scheduled run instead.
 *
 * Idempotent: `CREATE TABLE IF NOT EXISTS ... PARTITION OF` (valid
 * PostgreSQL syntax — `IF NOT EXISTS` applies to the table itself,
 * partition-of-ness included) means re-running this against
 * already-existing partitions is a safe no-op, not an error.
 *
 * Child partition naming: `payments_partitioned_YYYY_MM` /
 * `ledger_outbox_partitioned_YYYY_MM` — keeping the `_partitioned_`
 * naming Stage 1 originally used, **not** `payments_YYYY_MM`. Verified
 * live: Stage 2's cutover (`ALTER TABLE payments_partitioned RENAME TO
 * payments`) only renames the *parent* table — Postgres does not
 * cascade that rename to child partitions, so every partition created
 * before or after cutover is named `payments_partitioned_*`, forever,
 * even though the parent itself is now called `payments`. A first
 * attempt at this job used `payments_YYYY_MM` and failed immediately
 * with "partition would overlap partition \"payments_partitioned_2026_08\""
 * — this comment exists so nobody reintroduces that mismatch.
 */

const PARTITION_MAINTENANCE_MONTHS_AHEAD = Number(process.env.PARTITION_MAINTENANCE_MONTHS_AHEAD) || 2;

interface RunSummary {
  monthsAhead: number;
  partitionsChecked: number;
  partitionsCreated: string[];
  durationMs: number;
  status: 'success' | 'failed';
  error?: string;
}

const monthStart = (offset: number, ref: Date) =>
  new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + offset, 1));
const toDateStr = (d: Date) => d.toISOString().slice(0, 10);
const toSuffix = (d: Date) => `${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

async function tableExists(tableName: string): Promise<boolean> {
  const [{ exists }] = await AppDataSource.query(
    `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = $1) AS exists`,
    [tableName],
  );
  return exists;
}

export async function ensureUpcomingPartitions(now: Date = new Date()): Promise<{ checked: number; created: string[] }> {
  const created: string[] = [];
  let checked = 0;

  // 0 (current month) through PARTITION_MAINTENANCE_MONTHS_AHEAD inclusive
  // — current month included since a job that's late by even a few days
  // into a new month should still be able to self-heal.
  for (let offset = 0; offset <= PARTITION_MAINTENANCE_MONTHS_AHEAD; offset++) {
    const from = monthStart(offset, now);
    const to = monthStart(offset + 1, now);
    const suffix = toSuffix(from);
    const paymentsTable = `payments_partitioned_${suffix}`;
    const outboxTable = `ledger_outbox_partitioned_${suffix}`;
    checked += 2; // payments + ledger_outbox

    // Existence checked *before* creating — CREATE TABLE IF NOT EXISTS
    // always leaves the table present afterward, so checking after would
    // always report "already existed" regardless of what this run
    // actually did.
    const paymentsExistedBefore = await tableExists(paymentsTable);
    await AppDataSource.query(
      `CREATE TABLE IF NOT EXISTS "${paymentsTable}" PARTITION OF "payments" FOR VALUES FROM ('${toDateStr(from)}') TO ('${toDateStr(to)}')`,
    );
    if (!paymentsExistedBefore) {
      created.push(paymentsTable);
    }

    const outboxExistedBefore = await tableExists(outboxTable);
    await AppDataSource.query(
      `CREATE TABLE IF NOT EXISTS "${outboxTable}" PARTITION OF "ledger_outbox" FOR VALUES FROM ('${toDateStr(from)}') TO ('${toDateStr(to)}')`,
    );
    if (!outboxExistedBefore) {
      created.push(outboxTable);
    }
  }

  return { checked, created };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  await AppDataSource.initialize();
  try {
    const result = await ensureUpcomingPartitions();
    const summary: RunSummary = {
      monthsAhead: PARTITION_MAINTENANCE_MONTHS_AHEAD,
      partitionsChecked: result.checked,
      partitionsCreated: result.created,
      durationMs: Date.now() - startedAt,
      status: 'success',
    };
    console.log(JSON.stringify({ job: 'partition-maintenance', ...summary }));
  } catch (err) {
    const summary: Partial<RunSummary> = {
      monthsAhead: PARTITION_MAINTENANCE_MONTHS_AHEAD,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
    console.error(JSON.stringify({ job: 'partition-maintenance', ...summary }));
    throw err;
  } finally {
    await AppDataSource.destroy();
  }
}

if (require.main === module) {
  main().catch(() => {
    process.exit(1);
  });
}
