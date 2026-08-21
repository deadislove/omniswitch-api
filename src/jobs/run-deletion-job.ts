import 'dotenv/config';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { AppDataSource } from '../database/data-source';

/**
 * Deletion job (Phase 3, task 10c's second tier — see
 * docs/spec/future/database-scaling.md Option 3's "Three-tier policy").
 *
 * Same standalone-script, k8s-CronJob-driven shape as
 * `run-archiving-job.ts` — see that file's docblock for why this isn't
 * a `@Cron()` method.
 *
 * This is the tier the project previously said it would never do by
 * default — it now does, on an explicit, project-owner-approved policy
 * (2026-08-22): records past `DELETION_THRESHOLD_YEARS` (default 8,
 * counted from the record's original `created_at`, not from when it was
 * archived) are exported to a backup file, then deleted from the
 * database. **The backup is not optional**: `DELETION_BACKUP_REQUIRED`
 * defaults to `true`, and this job refuses to delete anything for a
 * batch whose backup file didn't write successfully — see `main()`.
 * Only ever operates on `archive.payments`/`archive.ledger_outbox`
 * (records already through the archive tier), never on the live
 * `payments`/`ledger_outbox` tables directly.
 *
 * The backup file is a local-disk JSON export — a POC-level mechanism,
 * not a production-grade one. `k8s/deletion-cronjob.yaml` mounts a
 * PersistentVolumeClaim at `DELETION_BACKUP_PATH` so the file survives
 * the CronJob pod's own lifecycle (an ephemeral pod's local filesystem
 * disappears with it otherwise) — see docs/compliance/data-retention.md
 * for what a real deployment should use instead (versioned,
 * access-controlled object storage with its own retention policy, since
 * this file becomes the *only* remaining copy of a deleted record).
 */

// Read per-call, not captured as module-level constants at import time —
// a real CronJob run only ever calls this once per process anyway, but
// per-call reads mean a test can exercise a different DELETION_BACKUP_PATH
// per case just by setting process.env before calling, no module-reload
// gymnastics required.
function deletionThresholdYears(): number {
  return Number(process.env.DELETION_THRESHOLD_YEARS) || 8;
}
function deletionBackupRequired(): boolean {
  return process.env.DELETION_BACKUP_REQUIRED !== 'false';
}
function deletionBackupPath(): string {
  return process.env.DELETION_BACKUP_PATH || './backups';
}

interface RunSummary {
  deletionThresholdYears: number;
  backupRequired: boolean;
  paymentsEligible: number;
  paymentsDeleted: number;
  ledgerOutboxEligible: number;
  ledgerOutboxDeleted: number;
  backupFile: string | null;
  durationMs: number;
  status: 'success' | 'failed';
  error?: string;
}

function writeBackupFile(records: { payments: unknown[]; ledgerOutbox: unknown[] }): string {
  const backupPath = deletionBackupPath();
  if (!existsSync(backupPath)) {
    mkdirSync(backupPath, { recursive: true });
  }
  const filename = `deletion-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const filePath = join(backupPath, filename);
  writeFileSync(filePath, JSON.stringify(records, null, 2));

  // Confirm the file actually landed on disk with real content before
  // treating the backup as successful — a write that silently truncated
  // (disk full, permission race) must not be treated as "backed up."
  if (!existsSync(filePath) || statSync(filePath).size === 0) {
    throw new Error(`Backup file ${filePath} was not written correctly (missing or empty)`);
  }
  return filePath;
}

export async function runDeletion(): Promise<{
  paymentsEligible: number;
  paymentsDeleted: number;
  ledgerOutboxEligible: number;
  ledgerOutboxDeleted: number;
  backupFile: string | null;
}> {
  const thresholdYears = deletionThresholdYears();
  const eligiblePayments = await AppDataSource.query(
    `SELECT * FROM "archive"."payments" WHERE created_at < now() - ($1 || ' years')::interval`,
    [thresholdYears],
  );
  const eligibleLedgerOutbox = await AppDataSource.query(
    `SELECT * FROM "archive"."ledger_outbox" WHERE created_at < now() - ($1 || ' years')::interval`,
    [thresholdYears],
  );

  let backupFile: string | null = null;
  let paymentsDeleted = 0;
  let ledgerOutboxDeleted = 0;

  if (eligiblePayments.length > 0 || eligibleLedgerOutbox.length > 0) {
    if (deletionBackupRequired()) {
      // Backup happens before any DELETE, and outside the DB
      // transaction below — if this throws, the caller sees the
      // exception and nothing is deleted.
      backupFile = writeBackupFile({ payments: eligiblePayments, ledgerOutbox: eligibleLedgerOutbox });
    }

    const runner = AppDataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      if (eligiblePayments.length > 0) {
        const ids = eligiblePayments.map((row: { id: string }) => row.id);
        await runner.query(`DELETE FROM "archive"."payments" WHERE "id" = ANY($1)`, [ids]);
        paymentsDeleted = ids.length;
      }
      if (eligibleLedgerOutbox.length > 0) {
        const ids = eligibleLedgerOutbox.map((row: { id: string }) => row.id);
        await runner.query(`DELETE FROM "archive"."ledger_outbox" WHERE "id" = ANY($1)`, [ids]);
        ledgerOutboxDeleted = ids.length;
      }
      await runner.commitTransaction();
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    } finally {
      await runner.release();
    }
  }

  return {
    paymentsEligible: eligiblePayments.length,
    paymentsDeleted,
    ledgerOutboxEligible: eligibleLedgerOutbox.length,
    ledgerOutboxDeleted,
    backupFile,
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  await AppDataSource.initialize();
  try {
    const result = await runDeletion();
    const summary: RunSummary = {
      deletionThresholdYears: deletionThresholdYears(),
      backupRequired: deletionBackupRequired(),
      ...result,
      durationMs: Date.now() - startedAt,
      status: 'success',
    };
    console.log(JSON.stringify({ job: 'deletion', ...summary }));
  } catch (err) {
    const summary: Partial<RunSummary> = {
      deletionThresholdYears: deletionThresholdYears(),
      backupRequired: deletionBackupRequired(),
      durationMs: Date.now() - startedAt,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
    console.error(JSON.stringify({ job: 'deletion', ...summary }));
    throw err;
  } finally {
    await AppDataSource.destroy();
  }
}

// Guarded so importing `runDeletion` from a test file doesn't also
// trigger a real run against whatever DB the test process happens to be
// configured against.
if (require.main === module) {
  main().catch(() => {
    process.exit(1);
  });
}
