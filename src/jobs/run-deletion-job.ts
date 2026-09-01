import 'dotenv/config';
import { AppDataSource } from '../database/data-source';
import { getBackupStorage } from './backup-storage/get-backup-storage';

/**
 * Deletion job — the second tier of the archive/delete lifecycle,
 * running after a record has already spent its time in the archive
 * schema.
 *
 * Same standalone-script, k8s-CronJob-driven shape as
 * `run-archiving-job.ts` — see that file's docblock for why this isn't
 * a `@Cron()` method.
 *
 * Deletes records past `DELETION_THRESHOLD_YEARS` (default 8, counted
 * from the record's original `created_at`, not from when it was
 * archived): exports them to a backup file, then removes them from the
 * database. **The backup is not optional**: `DELETION_BACKUP_REQUIRED`
 * defaults to `true`, and this job refuses to delete anything for a
 * batch whose backup file didn't write successfully — see `main()`.
 * Only ever operates on `archive.payments`/`archive.ledger_outbox`
 * (records already through the archive tier), never on the live
 * `payments`/`ledger_outbox` tables directly.
 *
 * Excludes any payment with a still-open dispute (`NEEDS_RESPONSE` or
 * `UNDER_REVIEW`), the same check `run-archiving-job.ts` applies before
 * archiving: a payment can be archived with no open dispute and then
 * get disputed years later (a long investigation, litigation), and age
 * alone crossing `DELETION_THRESHOLD_YEARS` must not override that — a
 * payment tied to an open dispute is never eligible here, regardless of
 * how long it's been archived.
 *
 * Also excludes any payment with `legal_hold` set (see
 * LegalHoldService). Belt-and-suspenders here, not the primary defense:
 * `LegalHoldService.placeHold()` pulls a held payment out of
 * `archive.payments` entirely (back into the live `payments` table), so
 * under normal operation this WHERE clause should never actually
 * exclude anything — but checking it here too costs nothing and
 * protects against this job ever deleting a held record if that
 * invariant is ever violated by a future bug.
 *
 * The backup destination is pluggable — see
 * `./backup-storage/get-backup-storage.ts` — selected via
 * `DELETION_BACKUP_STORAGE` (default `"local"`, a JSON file on disk;
 * `"s3"`/`"gcs"`/`"azure"` for the corresponding cloud object store).
 * The default stays local specifically so this project's GitHub
 * Actions CI, which never has real cloud credentials, keeps passing
 * with zero external configuration — see
 * docs/compliance/data-retention.md for the full reasoning and the
 * per-provider config each option needs.
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

/**
 * Backs up and deletes every eligible archived payment/ledger_outbox
 * entry (see the eligibility rules above) in one pass.
 *
 * Returns `paymentsEligible`/`ledgerOutboxEligible` (how many rows
 * matched at query time) and `paymentsDeleted`/`ledgerOutboxDeleted`
 * (how many were actually removed — always equal to the eligible count
 * here, since this job holds a transaction across the whole delete
 * unlike the archiving job's insert-with-conflict-skip). `backupFile`
 * is the location identifier `BackupStorage.write()` returned (a file
 * path or object-store URI, depending on the configured provider — see
 * `./backup-storage/get-backup-storage.ts`), or `null` if there was
 * nothing eligible to back up. Throws (and deletes nothing) if the
 * backup write fails — see the docblock above.
 */
export async function runDeletion(): Promise<{
  paymentsEligible: number;
  paymentsDeleted: number;
  ledgerOutboxEligible: number;
  ledgerOutboxDeleted: number;
  backupFile: string | null;
}> {
  const thresholdYears = deletionThresholdYears();
  const eligiblePayments = await AppDataSource.query(
    `SELECT * FROM "archive"."payments" p
     WHERE p.created_at < now() - ($1 || ' years')::interval
       AND NOT p.legal_hold
       AND NOT EXISTS (
         SELECT 1 FROM "disputes" d WHERE d.payment_id = p.id::varchar AND d.status = ANY($2)
       )`,
    [thresholdYears, ['NEEDS_RESPONSE', 'UNDER_REVIEW']],
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
      backupFile = await getBackupStorage().write({ payments: eligiblePayments, ledgerOutbox: eligibleLedgerOutbox });
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
